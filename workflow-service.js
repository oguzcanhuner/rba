const { spawn } = require('node:child_process');
const { existsSync, statSync } = require('node:fs');
const {
  validateDefinition,
  normaliseDefinition,
  nextStep,
} = require('./workflow-spec');

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const KILL_GRACE_MS = 5000;
const FLUSH_INTERVAL_MS = 250;

function envKeyFor(stepName) {
  return stepName.toUpperCase().replace(/[^A-Z0-9]/g, '_');
}

function safeParseJsonStatus(text) {
  let parsed;
  try {
    parsed = JSON.parse(text.trim());
  } catch {
    return {
      ok: false,
      error: 'Claude CLI returned invalid streaming output.',
    };
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    (parsed.status !== 'pass' && parsed.status !== 'fail')
  ) {
    return {
      ok: false,
      error:
        'The step’s JSON output must be an object with status "pass" or "fail".',
    };
  }
  return {
    ok: true,
    status: parsed.status,
    summary: typeof parsed.summary === 'string' ? parsed.summary : null,
    data: parsed.data !== undefined ? parsed.data : null,
  };
}

/** Executes a user-authored workflow: a start step plus a map of named
 * shell steps, routed by exit code or (for `parse: "json"` steps) a
 * reasoned verdict. A workflow `fail` is a normal routed outcome; an
 * engine error (bad JSON, a missing route, a visit-limit breach, a
 * timeout) halts the run instead of routing, so a broken workflow never
 * looks like one that decided something. */
class WorkflowService {
  constructor({
    store,
    onUpdate = () => {},
    spawnProcess = spawn,
    killProcessGroup = (pid, signal) => process.kill(-pid, signal),
    killGraceMs = KILL_GRACE_MS,
  }) {
    this.store = store;
    this.onUpdate = onUpdate;
    this.spawnProcess = spawnProcess;
    this.killProcessGroup = killProcessGroup;
    this.killGraceMs = killGraceMs;
    this.running = new Map(); // workflowId -> runtime
    this.disposed = false;
  }

  async start(workflowId, { directory, fresh = false } = {}) {
    if (this.running.has(workflowId)) {
      throw new Error('This workflow is already running.');
    }

    const workflow = this.store.getWorkflow(workflowId);
    if (!workflow) {
      throw new Error('The workflow no longer exists.');
    }

    const resolvedDirectory = directory || workflow.directory;
    if (!resolvedDirectory) {
      throw new Error(
        'No working directory is set for this workflow; choose one to run it.',
      );
    }
    if (
      !existsSync(resolvedDirectory) ||
      !statSync(resolvedDirectory).isDirectory()
    ) {
      throw new Error(`The directory \`${resolvedDirectory}\` does not exist.`);
    }

    const validation = validateDefinition(workflow.definition);
    if (!validation.ok) {
      throw new Error(
        `This workflow's definition is invalid: ${validation.errors.join(' ')}`,
      );
    }
    const definition = normaliseDefinition(workflow.definition);

    if (!fresh) {
      const latest = this.store.getLatestWorkflowRun(workflowId);
      if (latest && latest.status === 'running') {
        return this.resume(workflow, definition, latest);
      }
    }

    const startedAt = new Date().toISOString();
    const run = this.store.createWorkflowRun(workflowId, {
      directory: resolvedDirectory,
      currentStep: definition.start,
      startedAt,
    });

    const runtime = {
      workflowId,
      runId: run.id,
      definition,
      directory: resolvedDirectory,
      stopped: false,
      child: null,
      flushTimer: null,
    };
    this.running.set(workflowId, runtime);
    void this.drive(runtime, definition.start);
    return this.withActivity(this.store.getWorkflowRun(run.id));
  }

  resume(workflow, definition, run) {
    const runtime = {
      workflowId: workflow.id,
      runId: run.id,
      definition,
      directory: run.directory,
      stopped: false,
      child: null,
      flushTimer: null,
    };
    this.running.set(workflow.id, runtime);
    void this.drive(runtime, run.currentStep);
    return this.withActivity(run);
  }

  async drive(runtime, stepName) {
    let currentStep = stepName;

    while (!runtime.stopped) {
      const step = runtime.definition.steps[currentStep];

      if (step.type === 'terminal') {
        this.finish(runtime, 'completed', null, currentStep);
        return;
      }

      const priorVisits = this.store
        .getWorkflowRun(runtime.runId)
        .steps.filter((s) => s.step === currentStep).length;
      const maxVisits = step.maxVisits ?? 100;
      if (priorVisits >= maxVisits) {
        this.finish(
          runtime,
          'failed',
          `Step \`${currentStep}\` exceeded its visit limit of ${maxVisits}.`,
          currentStep,
        );
        return;
      }

      const position = this.store.getWorkflowRun(runtime.runId).steps.length;
      const stepRunId = this.store.startStepRun(runtime.runId, {
        position,
        step: currentStep,
        startedAt: new Date().toISOString(),
      });
      this.store.updateWorkflowRun(runtime.runId, {
        status: 'running',
        currentStep,
      });
      this.broadcast(runtime.runId);

      let outcome;
      try {
        outcome = await this.runStep(runtime, step, currentStep, stepRunId);
      } catch (error) {
        if (runtime.stopped) {
          return;
        }
        this.store.finishStepRun(stepRunId, {
          status: 'error',
          exitCode: null,
        });
        this.finish(
          runtime,
          'failed',
          error instanceof Error ? error.message : String(error),
          currentStep,
        );
        return;
      }

      if (runtime.stopped) {
        return;
      }

      if (outcome.status === 'error') {
        this.store.finishStepRun(stepRunId, {
          status: 'error',
          exitCode: outcome.exitCode ?? null,
        });
        this.finish(runtime, 'failed', outcome.error, currentStep);
        return;
      }

      this.store.finishStepRun(stepRunId, {
        status: outcome.status,
        summary: outcome.summary ?? null,
        data: outcome.data ?? null,
        exitCode: outcome.exitCode ?? null,
      });
      runtime.stepStatuses = runtime.stepStatuses ?? new Map();
      runtime.stepStatuses.set(currentStep, {
        status: outcome.status,
        summary: outcome.summary ?? null,
      });
      runtime.lastStatus = {
        status: outcome.status,
        summary: outcome.summary ?? null,
      };
      this.broadcast(runtime.runId);

      const routed = nextStep(step, outcome.status);
      if (!routed.ok) {
        this.finish(runtime, 'failed', routed.error, currentStep);
        return;
      }
      currentStep = routed.next;
    }
  }

  runStep(runtime, step, stepName, stepRunId) {
    return new Promise((resolve, reject) => {
      const env = { ...process.env };
      env.RBA_WORKFLOW = runtime.workflowId;
      env.RBA_RUN_ID = runtime.runId;
      env.RBA_STEP = stepName;
      if (runtime.lastStatus) {
        env.RBA_LAST_STATUS = runtime.lastStatus.status;
        if (runtime.lastStatus.summary) {
          env.RBA_LAST_SUMMARY = runtime.lastStatus.summary;
        }
      }
      for (const [name, info] of runtime.stepStatuses ?? []) {
        env[`RBA_STEP_${envKeyFor(name)}_STATUS`] = info.status;
      }

      let child;
      try {
        child = this.spawnProcess('sh', ['-c', step.run], {
          cwd: runtime.directory,
          env,
          detached: true,
        });
      } catch (error) {
        reject(error);
        return;
      }
      runtime.child = child;

      let stdout = '';
      let pendingStdout = '';
      let pendingStderr = '';
      let settled = false;
      let timeoutHandle;

      const flush = () => {
        if (pendingStdout || pendingStderr) {
          this.store.appendStepOutput(stepRunId, {
            stdout: pendingStdout,
            stderr: pendingStderr,
          });
          pendingStdout = '';
          pendingStderr = '';
          this.broadcast(runtime.runId);
        }
      };
      runtime.flushTimer = setInterval(flush, FLUSH_INTERVAL_MS);

      const cleanup = () => {
        clearInterval(runtime.flushTimer);
        runtime.flushTimer = null;
        clearTimeout(timeoutHandle);
        runtime.timeoutHandle = null;
        flush();
        runtime.child = null;
      };

      child.stdout?.on('data', (chunk) => {
        const text = chunk.toString();
        stdout += text;
        pendingStdout += text;
      });
      child.stderr?.on('data', (chunk) => {
        pendingStderr += chunk.toString();
      });

      const timeoutMs = step.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      runtime.settle = (result) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      };
      runtime.childClosed = new Promise((resolveClosed) => {
        runtime.resolveChildClosed = resolveClosed;
      });
      timeoutHandle = setTimeout(async () => {
        if (settled) return;
        runtime.terminationResult = {
          status: 'error',
          error: `Step \`${stepName}\` timed out after ${timeoutMs}ms.`,
        };
        await this.terminateChild(runtime);
        runtime.settle(runtime.terminationResult);
      }, timeoutMs);
      runtime.timeoutHandle = timeoutHandle;

      child.once('error', (error) => {
        runtime.resolveChildClosed?.();
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      });

      child.once('close', (code) => {
        runtime.resolveChildClosed?.();
        if (settled) return;
        if (runtime.terminationResult) {
          runtime.settle(runtime.terminationResult);
          return;
        }
        settled = true;
        cleanup();

        if (runtime.stopped) {
          resolve({ status: 'error', error: 'Stopped.' });
          return;
        }

        if (step.parse === 'json') {
          const parsed = safeParseJsonStatus(stdout);
          if (!parsed.ok) {
            resolve({ status: 'error', error: parsed.error, exitCode: code });
            return;
          }
          resolve({
            status: parsed.status,
            summary: parsed.summary,
            data: parsed.data,
            exitCode: code,
          });
          return;
        }

        resolve({
          status: code === 0 ? 'pass' : 'fail',
          exitCode: code,
        });
      });
    });
  }

  signalChild(child, signal) {
    try {
      this.killProcessGroup(child.pid, signal);
    } catch {
      child.kill(signal);
    }
  }

  async terminateChild(runtime) {
    const child = runtime.child;
    if (!child) return;
    this.signalChild(child, 'SIGTERM');
    let graceTimer;
    const exited = await Promise.race([
      runtime.childClosed.then(() => true),
      new Promise((resolve) => {
        graceTimer = setTimeout(() => resolve(false), this.killGraceMs);
      }),
    ]);
    clearTimeout(graceTimer);
    if (!exited && runtime.child === child) {
      this.signalChild(child, 'SIGKILL');
    }
  }

  isRunning(runId) {
    return [...this.running.values()].some(
      (runtime) => runtime.runId === runId,
    );
  }

  withActivity(run) {
    return run ? { ...run, isActive: this.isRunning(run.id) } : null;
  }

  async stop(runId) {
    const runtime = [...this.running.values()].find((r) => r.runId === runId);
    if (!runtime) {
      throw new Error('This workflow run is not running.');
    }
    runtime.stopped = true;
    await this.terminateChild(runtime);
    if (runtime.flushTimer) {
      clearInterval(runtime.flushTimer);
      runtime.flushTimer = null;
    }
    if (runtime.timeoutHandle) {
      clearTimeout(runtime.timeoutHandle);
      runtime.timeoutHandle = null;
    }
    runtime.settle?.({ status: 'error', error: 'Stopped.' });
    const run = this.store.getWorkflowRun(runId);
    const runningStep = run.steps.find((s) => s.status === 'running');
    if (runningStep) {
      this.store.finishStepRun(runningStep.id, { status: 'stopped' });
    }
    const stoppedRun = this.store.updateWorkflowRun(runId, {
      status: 'stopped',
      currentStep: run.currentStep,
    });
    this.running.delete(runtime.workflowId);
    if (!this.disposed) {
      this.onUpdate(stoppedRun);
    }
    return this.withActivity(stoppedRun);
  }

  async delete(workflowId) {
    const runtime = this.running.get(workflowId);
    if (runtime) {
      await this.stop(runtime.runId);
    } else {
      const latest = this.store.getLatestWorkflowRun(workflowId);
      if (latest?.status === 'running') {
        this.store.updateWorkflowRun(latest.id, {
          status: 'stopped',
          currentStep: latest.currentStep,
        });
      }
    }
    this.store.deleteWorkflow(workflowId);
  }

  async shutdown() {
    for (const runtime of this.running.values()) {
      try {
        await this.stop(runtime.runId);
      } catch {
        // Already finished between the check and the call.
      }
    }
    this.disposed = true;
  }

  finish(runtime, status, error, currentStep) {
    if (runtime.stopped) {
      return;
    }
    const run = this.store.updateWorkflowRun(runtime.runId, {
      status,
      currentStep: status === 'completed' ? null : currentStep,
      error,
    });
    this.running.delete(runtime.workflowId);
    if (!this.disposed) {
      this.onUpdate(this.withActivity(run));
    }
  }

  broadcast(runId) {
    if (!this.disposed) {
      this.onUpdate(this.withActivity(this.store.getWorkflowRun(runId)));
    }
  }
}

module.exports = { WorkflowService };
