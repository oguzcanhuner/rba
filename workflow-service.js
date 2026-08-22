const { execFile, fork } = require('node:child_process');
const path = require('node:path');
const { promisify } = require('node:util');
const { beginWorkerCli } = require('./claude-cli-service');
const { compileWorkflow } = require('./workflow-compiler');

const execFileAsync = promisify(execFile);

function appendText(parts, text, operationId) {
  const last = parts.at(-1);
  if (last?.type === 'text') {
    return [...parts.slice(0, -1), { ...last, text: last.text + text }];
  }
  return [
    ...parts,
    { type: 'text', id: `${operationId}-text-${parts.length}`, text },
  ];
}

function finishTools(parts, status) {
  return parts.map((part) =>
    part.type === 'tool' && part.tool.status === 'running'
      ? { ...part, tool: { ...part.tool, status } }
      : part,
  );
}

class WorkflowService {
  constructor({
    store,
    taskStore,
    worktreesDirectory,
    onUpdate = () => {},
    compile = compileWorkflow,
    spawnHost = fork,
    runCommand = execFileAsync,
    beginAgent = beginWorkerCli,
    makeDirectory = require('node:fs/promises').mkdir,
  }) {
    Object.assign(this, {
      store,
      taskStore,
      worktreesDirectory,
      onUpdate,
      compile,
      spawnHost,
      runCommand,
      beginAgent,
      makeDirectory,
    });
    this.hosts = new Map();
    this.agents = new Map();
    this.disposed = false;
  }

  async start(taskId, sourcePath) {
    const task = this.taskStore.getTaskForWorker(taskId);
    if (!task) throw new Error('The task no longer exists.');
    if (task.status !== 'queued')
      throw new Error('Only queued tasks can be started.');
    const current = this.store.getTaskRun(taskId);
    if (current && ['running', 'waiting'].includes(current.status)) {
      return this.store.publicRun(current);
    }
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
    let run = this.store.createRun({
      taskId,
      workflowName,
      sourcePath,
      sourceHash,
      bundledSource,
      input,
    });
    try {
      const workspace = await this.createWorkspace(task, run.id);
      input.task.workspace = workspace.worktree;
      run = this.store.setWorkspace(run.id, { ...workspace, input });
      this.store.updateTaskStatus(taskId, 'working');
      this.launch(run);
      this.broadcast(run);
      return this.store.publicRun(run);
    } catch (error) {
      this.store.finishRun(run.id, 'failed', {
        error: String(error.message ?? error),
      });
      throw error;
    }
  }

  async createWorkspace(task, runId) {
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
    const branch = `rba/${task.id}-${runId.slice(0, 8)}`;
    const worktree = path.join(this.worktreesDirectory, runId);
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
    return { branch, worktree, baseRevision };
  }

  get(taskId) {
    return this.store.publicRun(this.store.getTaskRun(taskId));
  }

  resume(run) {
    if (run?.status !== 'running') return;
    this.launch(run);
    this.broadcast(run);
  }

  launch(run) {
    if (this.disposed) return;
    const host = this.spawnHost(path.join(__dirname, 'workflow-host.js'), [], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    this.hosts.set(run.id, host);
    host.on('message', (message) => {
      void this.handleMessage(run.id, host, message);
    });
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
      this.store.updateTaskStatus(run.taskId, 'completed');
      this.broadcast(run);
      host.disconnect();
      return;
    }
    if (message.type === 'failed') {
      const run = this.store.finishRun(runId, 'failed', {
        error: message.error,
      });
      this.store.updateTaskStatus(run.taskId, 'failed');
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
      } else if (existing?.status === 'failed') {
        host.send({
          type: 'operation-result',
          requestId: message.requestId,
          error: existing.error,
        });
      } else if (message.operationType === 'human') {
        this.store.startOperation(
          runId,
          message.key,
          'human',
          message.input,
          'waiting',
        );
        this.broadcast(this.store.getRun(runId));
      } else if (message.operationType === 'command') {
        await this.executeCommand(runId, host, message);
      } else if (message.operationType === 'agent') {
        await this.executeAgent(runId, host, message);
      } else if (message.operationType === 'sleep') {
        this.executeSleep(runId, host, message);
      } else {
        throw new Error(
          `Unsupported workflow operation: ${message.operationType}`,
        );
      }
    } catch (error) {
      this.rejectOperation(runId, host, message, error);
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
    let output;
    try {
      const result = await this.runCommand(command, args, {
        cwd: options.cwd ?? run.worktree,
        encoding: 'utf8',
        maxBuffer: 20 * 1024 * 1024,
        timeout: options.timeoutMs,
      });
      output = {
        ok: true,
        exitCode: 0,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
      };
    } catch (error) {
      output = {
        ok: false,
        exitCode: Number.isInteger(error.code) ? error.code : null,
        stdout: error.stdout ?? '',
        stderr: error.stderr ?? '',
      };
    }
    this.store.completeOperation(runId, message.key, output);
    host.send({
      type: 'operation-result',
      requestId: message.requestId,
      output,
    });
    this.broadcast(this.store.getRun(runId));
  }

  async executeAgent(runId, host, message) {
    const run = this.store.getRun(runId);
    const options = message.input;
    if (
      !options ||
      typeof options.prompt !== 'string' ||
      !options.prompt.trim()
    ) {
      throw new Error('Agent operations require a prompt.');
    }
    if (
      options.timeoutMs !== undefined &&
      (!Number.isFinite(options.timeoutMs) ||
        options.timeoutMs <= 0 ||
        options.timeoutMs > 86_400_000)
    ) {
      throw new Error('Agent timeoutMs must be between 1 and 86400000.');
    }
    const diff = options.includeDiff
      ? (await this.getDiff(run.taskId)).patch
      : null;
    const prompt =
      diff === null
        ? options.prompt
        : `${options.prompt}\n\n# Current worktree diff\n\n${diff || '(No changes.)'}`;
    const operation = this.store.startOperation(
      runId,
      message.key,
      'agent',
      options,
    );
    const sessionName =
      typeof options.session === 'string' && options.session
        ? options.session
        : message.key;
    const sessionId = this.store.getAgentSession(runId, sessionName);
    const assistantMessage = {
      id: `workflow-agent-${operation.id}`,
      role: 'assistant',
      status: 'streaming',
      parts: [],
    };
    this.store.saveMessage(operation.id, assistantMessage);
    const runtime = {
      runId,
      key: message.key,
      requestId: message.requestId,
      host,
      operation,
      message: assistantMessage,
      stream: null,
      text: '',
    };
    this.agents.set(`${runId}:${message.key}`, runtime);
    runtime.stream = this.beginAgent({
      prompt,
      sessionId,
      cwd: run.worktree,
      onText: (text) => {
        runtime.text += text;
        runtime.message = {
          ...runtime.message,
          parts: appendText(runtime.message.parts, text, operation.id),
        };
        this.persistAgent(runtime);
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
        this.persistAgent(runtime);
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
                    input: this.relativeToolInput(tool.input, run.worktree),
                  },
                }
              : part,
          ),
        };
        this.persistAgent(runtime);
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
        this.persistAgent(runtime);
      },
    });
    if (options.timeoutMs !== undefined) {
      runtime.timeout = setTimeout(
        () => runtime.stream.cancel(),
        options.timeoutMs,
      );
    }
    void runtime.stream.completion.then(
      (result) => {
        this.store.saveAgentSession(runId, sessionName, result.sessionId);
        this.finishAgent(runtime, {
          sessionId: result.sessionId,
          text: runtime.text,
        });
      },
      (error) => this.failAgent(runtime, error),
    );
    this.broadcast(this.store.getRun(runId));
  }

  executeSleep(runId, host, message) {
    const milliseconds = message.input?.milliseconds;
    if (
      !Number.isFinite(milliseconds) ||
      milliseconds < 0 ||
      milliseconds > 86_400_000
    ) {
      throw new Error(
        'Sleep operations require milliseconds between 0 and 86400000.',
      );
    }
    this.store.startOperation(runId, message.key, 'sleep', message.input);
    setTimeout(() => {
      this.store.completeOperation(runId, message.key, null);
      host.send({
        type: 'operation-result',
        requestId: message.requestId,
        output: null,
      });
      this.broadcast(this.store.getRun(runId));
    }, milliseconds);
    this.broadcast(this.store.getRun(runId));
  }

  persistAgent(runtime) {
    this.store.saveMessage(runtime.operation.id, runtime.message);
    this.broadcast(this.store.getRun(runtime.runId));
  }

  finishAgent(runtime, output) {
    if (runtime.timeout) clearTimeout(runtime.timeout);
    runtime.message = {
      ...runtime.message,
      status: 'complete',
      parts: finishTools(runtime.message.parts, 'complete'),
    };
    this.store.saveMessage(runtime.operation.id, runtime.message);
    this.store.completeOperation(runtime.runId, runtime.key, output);
    runtime.host.send({
      type: 'operation-result',
      requestId: runtime.requestId,
      output,
    });
    this.agents.delete(`${runtime.runId}:${runtime.key}`);
    this.broadcast(this.store.getRun(runtime.runId));
  }

  failAgent(runtime, error) {
    if (runtime.timeout) clearTimeout(runtime.timeout);
    const text = error instanceof Error ? error.message : String(error);
    runtime.message = {
      ...runtime.message,
      status: 'error',
      parts: finishTools(runtime.message.parts, 'error'),
    };
    this.store.saveMessage(runtime.operation.id, runtime.message);
    this.store.failOperation(runtime.runId, runtime.key, text);
    runtime.host.send({
      type: 'operation-result',
      requestId: runtime.requestId,
      error: text,
    });
    this.agents.delete(`${runtime.runId}:${runtime.key}`);
    this.broadcast(this.store.getRun(runtime.runId));
  }

  rejectOperation(runId, host, message, error) {
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

  resolveHuman(runId, key, value) {
    const operation = this.store.getOperation(runId, key);
    if (operation?.type !== 'human' || operation.status !== 'waiting') {
      throw new Error('This workflow is not waiting for that input.');
    }
    this.store.completeOperation(runId, key, value);
    this.hosts.get(runId)?.kill();
    const run = this.store.getRun(runId);
    this.store.touchRun(runId, 'running');
    this.launch(run);
    this.broadcast(this.store.getRun(runId));
    return this.store.publicRun(this.store.getRun(runId));
  }

  stop(runId) {
    const run = this.store.getRun(runId);
    if (!run || !['running', 'waiting'].includes(run.status)) {
      throw new Error('This workflow is not running.');
    }
    for (const [key, runtime] of this.agents) {
      if (runtime.runId === runId) {
        runtime.stream?.cancel();
        this.agents.delete(key);
      }
    }
    this.hosts.get(runId)?.kill();
    const stopped = this.store.finishRun(runId, 'stopped');
    this.store.updateTaskStatus(run.taskId, 'stopped');
    this.broadcast(stopped);
    return this.store.publicRun(stopped);
  }

  async getDiff(taskId) {
    const run = this.store.getTaskRun(taskId);
    if (!run?.baseRevision || !run.worktree) return { patch: '' };
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
    const { stdout: untracked } = await this.runCommand(
      'git',
      ['-C', run.worktree, 'ls-files', '--others', '--exclude-standard', '-z'],
      options,
    );
    const patches = [stdout];
    for (const file of untracked.split('\0').filter(Boolean)) {
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
        if (error?.code !== 1 || typeof error.stdout !== 'string') throw error;
        patches.push(error.stdout);
      }
    }
    return { patch: patches.filter(Boolean).join('\n') };
  }

  relativeToolInput(input, cwd) {
    if (!input || typeof input !== 'object') return input;
    const relative = { ...input };
    for (const key of ['file_path', 'path', 'pattern']) {
      if (typeof relative[key] === 'string' && path.isAbsolute(relative[key])) {
        relative[key] = path.relative(cwd, relative[key]) || '.';
      }
    }
    return relative;
  }

  broadcast(run) {
    if (!this.disposed) this.onUpdate(this.store.publicRun(run));
  }

  shutdown() {
    this.disposed = true;
    for (const runtime of this.agents.values()) runtime.stream?.cancel();
    for (const host of this.hosts.values()) host.kill();
    this.agents.clear();
    this.hosts.clear();
  }
}

module.exports = { WorkflowService };
