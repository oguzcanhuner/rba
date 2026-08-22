const { execFile } = require('node:child_process');
const { fork } = require('node:child_process');
const path = require('node:path');
const { promisify } = require('node:util');
const { compileWorkflow } = require('./workflow-compiler');

const execFileAsync = promisify(execFile);

class WorkflowService {
  constructor({
    store,
    taskStore,
    onUpdate = () => {},
    compile = compileWorkflow,
    spawnHost = fork,
    runCommand = execFileAsync,
  }) {
    this.store = store;
    this.taskStore = taskStore;
    this.onUpdate = onUpdate;
    this.compile = compile;
    this.spawnHost = spawnHost;
    this.runCommand = runCommand;
    this.hosts = new Map();
  }

  async start(taskId, sourcePath) {
    const task = this.taskStore.getTaskForWorker(taskId);
    if (!task) throw new Error('The task no longer exists.');
    const current = this.store.getTaskRun(taskId);
    if (current && ['running', 'waiting'].includes(current.status))
      return this.store.publicRun(current);
    const { bundledSource, sourceHash } = await this.compile(sourcePath);
    const workflowName = path
      .basename(sourcePath)
      .replace(/\.workflow\.[^.]+$/, '');
    const input = {
      task: {
        id: task.id,
        title: task.title,
        spec: task.specMarkdown,
        workingDirectory: task.workingDirectory,
      },
    };
    const run = this.store.createRun({
      taskId,
      workflowName,
      sourcePath,
      sourceHash,
      bundledSource,
      input,
    });
    this.launch(run);
    return this.store.publicRun(this.store.getRun(run.id));
  }

  get(taskId) {
    return this.store.publicRun(this.store.getTaskRun(taskId));
  }

  launch(run) {
    const host = this.spawnHost(path.join(__dirname, 'workflow-host.js'), [], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    this.hosts.set(run.id, host);
    host.on(
      'message',
      (message) => void this.handleMessage(run.id, host, message),
    );
    host.on('exit', () => {
      if (this.hosts.get(run.id) === host) this.hosts.delete(run.id);
    });
    host.send({
      type: 'start',
      bundledSource: run.bundledSource,
      sourcePath: run.sourcePath,
      input: run.input,
    });
  }

  async handleMessage(runId, host, message) {
    if (message.type === 'complete') {
      const run = this.store.finishRun(runId, 'completed', {
        output: message.output,
      });
      this.broadcast(run);
      host.disconnect();
      return;
    }
    if (message.type === 'failed') {
      const run = this.store.finishRun(runId, 'failed', {
        error: message.error,
      });
      this.broadcast(run);
      host.disconnect();
      return;
    }
    if (message.type !== 'operation') return;
    try {
      const existing = this.store.getOperation(runId, message.key);
      if (existing?.status === 'completed') {
        host.send({
          type: 'operation-result',
          requestId: message.requestId,
          output: existing.output,
        });
        return;
      }
      if (existing?.status === 'failed') {
        host.send({
          type: 'operation-result',
          requestId: message.requestId,
          error: existing.error,
        });
        return;
      }
      if (message.operationType === 'human') {
        this.store.startOperation(
          runId,
          message.key,
          'human',
          message.input,
          'waiting',
        );
        this.broadcast(this.store.getRun(runId));
        return;
      }
      if (message.operationType === 'command') {
        await this.executeCommand(runId, host, message);
        return;
      }
      throw new Error(
        `Unsupported workflow operation: ${message.operationType}`,
      );
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      const operation = this.store.getOperation(runId, message.key);
      if (operation) this.store.failOperation(runId, message.key, text);
      host.send({
        type: 'operation-result',
        requestId: message.requestId,
        error: text,
      });
      this.broadcast(this.store.getRun(runId));
    }
  }

  async executeCommand(runId, host, message) {
    const run = this.store.getRun(runId);
    const options = message.input;
    if (
      !options ||
      !Array.isArray(options.command) ||
      options.command.length === 0 ||
      !options.command.every((part) => typeof part === 'string')
    ) {
      throw new Error('Command operations require a non-empty string array.');
    }
    this.store.startOperation(runId, message.key, 'command', options);
    this.broadcast(this.store.getRun(runId));
    const [command, ...args] = options.command;
    try {
      const result = await this.runCommand(command, args, {
        cwd: options.cwd ?? run.input.task.workingDirectory,
        encoding: 'utf8',
        maxBuffer: 20 * 1024 * 1024,
        timeout: options.timeoutMs,
      });
      const output = {
        ok: true,
        exitCode: 0,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
      };
      this.store.completeOperation(runId, message.key, output);
      host.send({
        type: 'operation-result',
        requestId: message.requestId,
        output,
      });
    } catch (error) {
      const output = {
        ok: false,
        exitCode: Number.isInteger(error.code) ? error.code : null,
        stdout: error.stdout ?? '',
        stderr: error.stderr ?? '',
      };
      this.store.completeOperation(runId, message.key, output);
      host.send({
        type: 'operation-result',
        requestId: message.requestId,
        output,
      });
    }
    this.broadcast(this.store.getRun(runId));
  }

  resolveHuman(runId, key, value) {
    const operation = this.store.getOperation(runId, key);
    if (
      !operation ||
      operation.type !== 'human' ||
      operation.status !== 'waiting'
    ) {
      throw new Error('This workflow is not waiting for that input.');
    }
    this.store.completeOperation(runId, key, value);
    const host = this.hosts.get(runId);
    if (host) {
      // Replay provides a simple, uniform resume path and avoids retaining request IDs.
      host.kill();
    }
    const run = this.store.getRun(runId);
    this.store.touchRun(runId, 'running');
    this.launch(run);
    this.broadcast(this.store.getRun(runId));
  }

  broadcast(run) {
    this.onUpdate(this.store.publicRun(run));
  }

  shutdown() {
    for (const host of this.hosts.values()) host.kill();
    this.hosts.clear();
  }
}

module.exports = { WorkflowService };
