const { execFile } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { mkdir } = require('node:fs/promises');
const path = require('node:path');
const { promisify } = require('node:util');
const { beginWorkerCli } = require('./claude-cli-service');

const execFileAsync = promisify(execFile);

function appendText(parts, text, taskId) {
  const last = parts.at(-1);
  if (last?.type === 'text') {
    return [...parts.slice(0, -1), { ...last, text: last.text + text }];
  }
  return [
    ...parts,
    { type: 'text', id: `${taskId}-text-${parts.length}`, text },
  ];
}

function finishTools(parts, status) {
  return parts.map((part) =>
    part.type === 'tool' && part.tool.status === 'running'
      ? { ...part, tool: { ...part.tool, status } }
      : part,
  );
}

function workerTaskPrompt(task) {
  const findings = task.findingsMarkdown?.trim()
    ? task.findingsMarkdown
    : '(No exploration findings were recorded.)';
  return `Implement this task autonomously and then stop.

# Task

${task.title}

${task.specMarkdown}

# Exploration findings

${findings}`;
}

class WorkerService {
  constructor({
    store,
    worktreesDirectory,
    onUpdate = () => {},
    beginWorker = beginWorkerCli,
    runCommand = execFileAsync,
    makeDirectory = mkdir,
  }) {
    this.store = store;
    this.worktreesDirectory = worktreesDirectory;
    this.onUpdate = onUpdate;
    this.beginWorker = beginWorker;
    this.runCommand = runCommand;
    this.makeDirectory = makeDirectory;
    this.running = new Map();
    this.disposed = false;
  }

  async start(taskId) {
    if (this.running.has(taskId) || this.store.getWorkerRun(taskId)) {
      throw new Error('This task has already been started.');
    }

    const task = this.store.getTaskForWorker(taskId);
    if (!task) {
      throw new Error('The task no longer exists.');
    }
    if (task.status !== 'queued') {
      throw new Error('Only queued tasks can be started.');
    }

    const { stdout: rootOutput } = await this.runCommand(
      'git',
      ['-C', task.workingDirectory, 'rev-parse', '--show-toplevel'],
      { encoding: 'utf8' },
    );
    const repositoryRoot = rootOutput.trim();
    const { stdout: revisionOutput } = await this.runCommand(
      'git',
      ['-C', repositoryRoot, 'rev-parse', 'HEAD'],
      { encoding: 'utf8' },
    );
    const baseRevision = revisionOutput.trim();
    const branch = `rba/${taskId}`;
    const worktree = path.join(this.worktreesDirectory, taskId);
    await this.makeDirectory(this.worktreesDirectory, { recursive: true });
    await this.runCommand(
      'git',
      [
        '-C',
        repositoryRoot,
        'worktree',
        'add',
        '-b',
        branch,
        worktree,
        baseRevision,
      ],
      { encoding: 'utf8' },
    );

    const startedAt = new Date().toISOString();
    const message = {
      id: `worker-${taskId}`,
      role: 'assistant',
      status: 'streaming',
      parts: [],
    };
    this.store.createWorkerRun(taskId, {
      branch,
      worktree,
      baseRevision,
      startedAt,
    });
    this.store.saveWorkerMessage(taskId, message);
    this.broadcast(taskId);

    const runtime = {
      taskId,
      message,
      stream: null,
      finalized: false,
      messagePosition: 0,
    };
    this.running.set(taskId, runtime);
    this.launch(runtime, workerTaskPrompt(task), worktree);

    return this.store.getWorkerRun(taskId);
  }

  send(taskId, prompt) {
    if (this.running.has(taskId)) {
      throw new Error('Wait for the worker to finish responding.');
    }
    const run = this.store.getWorkerRun(taskId);
    if (!run) {
      throw new Error('The worker no longer exists.');
    }
    if (!run.sessionId) {
      throw new Error('This worker cannot receive another message yet.');
    }

    const turnId = randomUUID();
    const userMessage = {
      id: `worker-user-${turnId}`,
      role: 'user',
      status: 'complete',
      parts: [{ type: 'text', id: `${turnId}-text-0`, text: prompt }],
    };
    const assistantMessage = {
      id: `worker-assistant-${turnId}`,
      role: 'assistant',
      status: 'streaming',
      parts: [],
    };
    const { assistantPosition } = this.store.beginWorkerTurn(
      taskId,
      userMessage,
      assistantMessage,
    );
    const runtime = {
      taskId,
      message: assistantMessage,
      stream: null,
      finalized: false,
      messagePosition: assistantPosition,
    };
    this.running.set(taskId, runtime);
    this.broadcast(taskId);
    this.launch(runtime, prompt, run.worktree, run.sessionId);
    return this.store.getWorkerRun(taskId);
  }

  launch(runtime, prompt, worktree, sessionId) {
    try {
      runtime.stream = this.beginWorker({
        prompt,
        sessionId,
        cwd: worktree,
        onText: (text) => {
          runtime.message = {
            ...runtime.message,
            parts: appendText(runtime.message.parts, text, runtime.taskId),
          };
          this.persist(runtime);
        },
        onToolStart: (tool) => {
          runtime.message = {
            ...runtime.message,
            parts: [
              ...runtime.message.parts,
              {
                type: 'tool',
                tool: { ...tool, input: null, status: 'running' },
              },
            ],
          };
          this.persist(runtime);
        },
        onToolInput: (tool) => {
          runtime.message = {
            ...runtime.message,
            parts: runtime.message.parts.map((part) =>
              part.type === 'tool' && part.tool.id === tool.id
                ? {
                    ...part,
                    tool: {
                      ...part.tool,
                      input: this.relativeToolInput(tool.input, worktree),
                    },
                  }
                : part,
            ),
          };
          this.persist(runtime);
        },
        onToolResult: (tool) => {
          runtime.message = {
            ...runtime.message,
            parts: runtime.message.parts.map((part) =>
              part.type === 'tool' && part.tool.id === tool.id
                ? {
                    ...part,
                    tool: {
                      ...part.tool,
                      status: tool.isError ? 'error' : 'complete',
                    },
                  }
                : part,
            ),
          };
          this.persist(runtime);
        },
      });
      void runtime.stream.completion.then(
        (result) => this.finalize(runtime, 'completed', result.sessionId),
        (error) =>
          this.finalize(
            runtime,
            'failed',
            null,
            error instanceof Error ? error.message : String(error),
          ),
      );
    } catch (error) {
      this.finalize(
        runtime,
        'failed',
        null,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  async getDiff(taskId) {
    const run = this.store.getWorkerRun(taskId);
    if (!run) {
      throw new Error('The worker no longer exists.');
    }
    if (!run.baseRevision) {
      return { patch: '' };
    }

    const options = { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 };
    const { stdout } = await this.runCommand(
      'git',
      [
        '-C',
        run.worktree,
        '-c',
        'core.quotePath=false',
        'diff',
        '--no-ext-diff',
        '--find-renames',
        '--unified=3',
        '--no-color',
        run.baseRevision,
        '--',
      ],
      options,
    );
    const { stdout: untrackedOutput } = await this.runCommand(
      'git',
      ['-C', run.worktree, 'ls-files', '--others', '--exclude-standard', '-z'],
      options,
    );
    const patches = [stdout];
    for (const file of untrackedOutput.split('\0').filter(Boolean)) {
      try {
        const result = await this.runCommand(
          'git',
          [
            '-C',
            run.worktree,
            '-c',
            'core.quotePath=false',
            'diff',
            '--no-index',
            '--unified=3',
            '--no-color',
            '--',
            '/dev/null',
            file,
          ],
          options,
        );
        patches.push(result.stdout);
      } catch (error) {
        if (error?.code !== 1 || typeof error.stdout !== 'string') {
          throw error;
        }
        patches.push(error.stdout);
      }
    }
    return { patch: patches.filter(Boolean).join('\n') };
  }

  stop(taskId) {
    const runtime = this.running.get(taskId);
    if (!runtime) {
      throw new Error('This worker is not running.');
    }
    runtime.stream?.cancel();
    return this.finalize(runtime, 'stopped');
  }

  shutdown() {
    for (const runtime of this.running.values()) {
      runtime.stream?.cancel();
      this.finalize(runtime, 'stopped');
    }
    this.disposed = true;
  }

  persist(runtime) {
    if (runtime.finalized || this.disposed) {
      return;
    }
    this.store.saveWorkerMessage(
      runtime.taskId,
      runtime.message,
      runtime.messagePosition,
    );
    this.broadcast(runtime.taskId);
  }

  finalize(runtime, status, sessionId = null, error = null) {
    if (runtime.finalized) {
      return this.store.getWorkerRun(runtime.taskId);
    }
    runtime.finalized = true;
    runtime.message = {
      ...runtime.message,
      status:
        status === 'completed'
          ? 'complete'
          : status === 'stopped'
            ? 'cancelled'
            : 'error',
      parts: finishTools(
        runtime.message.parts,
        status === 'completed'
          ? 'complete'
          : status === 'stopped'
            ? 'cancelled'
            : 'error',
      ),
    };
    this.store.saveWorkerMessage(
      runtime.taskId,
      runtime.message,
      runtime.messagePosition,
    );
    const run = this.store.updateWorkerRun(runtime.taskId, {
      status,
      sessionId,
      error,
    });
    this.running.delete(runtime.taskId);
    if (!this.disposed) {
      this.onUpdate(run);
    }
    return run;
  }

  broadcast(taskId) {
    if (!this.disposed) {
      this.onUpdate(this.store.getWorkerRun(taskId));
    }
  }

  relativeToolInput(input, cwd) {
    if (!input || typeof input !== 'object') {
      return input;
    }
    const relativeInput = { ...input };
    for (const key of ['file_path', 'path', 'pattern']) {
      if (
        typeof relativeInput[key] === 'string' &&
        path.isAbsolute(relativeInput[key])
      ) {
        relativeInput[key] = path.relative(cwd, relativeInput[key]) || '.';
      }
    }
    return relativeInput;
  }
}

module.exports = { WorkerService, workerTaskPrompt };
