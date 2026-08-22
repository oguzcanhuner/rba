const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const { realpath, stat } = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { beginClaudeCli } = require('./claude-cli-service');
const { GoalStore } = require('./goal-store');
const { WorkerService } = require('./worker-service');
const { listWorkflows } = require('./workflow-discovery');
const { WorkflowService } = require('./workflow-service');
const { WorkflowStore } = require('./workflow-store');

const activeRequests = new Map();
let goalStore;
let goalDatabase;
let workerService;
let workflowService;
let workflowStore;

function sendClaudeEvent(webContents, payload) {
  if (!webContents.isDestroyed()) {
    webContents.send('claude:event', payload);
  }
}

function broadcastWorker(run) {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.webContents.isDestroyed()) {
      window.webContents.send('workers:event', { type: 'worker-updated', run });
    }
  }
}

function broadcastWorkflow(run) {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.webContents.isDestroyed()) {
      window.webContents.send('workflows:event', {
        type: 'workflow-updated',
        run,
      });
    }
  }
}

function isTrustedSender(frame) {
  if (!frame) {
    return false;
  }

  const developmentUrl = process.env.VITE_DEV_SERVER_URL;

  if (developmentUrl) {
    return new URL(frame.url).origin === new URL(developmentUrl).origin;
  }

  const rendererUrl = pathToFileURL(
    path.join(__dirname, 'dist', 'index.html'),
  ).href;

  return frame.url === rendererUrl;
}

function isValidStartRequest(request) {
  return Boolean(
    request &&
      typeof request.requestId === 'string' &&
      request.requestId.length <= 100 &&
      typeof request.goalId === 'string' &&
      request.goalId.length > 0 &&
      request.goalId.length <= 100 &&
      typeof request.prompt === 'string' &&
      request.prompt.trim().length > 0 &&
      request.prompt.length <= 100_000 &&
      typeof request.cwd === 'string' &&
      request.cwd.length > 0 &&
      request.cwd.length <= 4096 &&
      path.isAbsolute(request.cwd) &&
      (request.sessionId === undefined ||
        (typeof request.sessionId === 'string' &&
          request.sessionId.length > 0 &&
          request.sessionId.length <= 200)),
  );
}

function isValidGoal(goal) {
  const auditArtifactsJson = Array.isArray(goal?.auditArtifacts)
    ? JSON.stringify(goal.auditArtifacts)
    : '';
  const validAuditArtifacts =
    Array.isArray(goal?.auditArtifacts) &&
    goal.auditArtifacts.length <= 200 &&
    auditArtifactsJson.length <= 500_000 &&
    goal.auditArtifacts.every(
      (artifact) =>
        artifact &&
        typeof artifact.id === 'string' &&
        artifact.id.length > 0 &&
        artifact.id.length <= 100 &&
        artifact.kind === 'test-trace' &&
        typeof artifact.framework === 'string' &&
        artifact.framework.length > 0 &&
        artifact.framework.length <= 100 &&
        typeof artifact.testPath === 'string' &&
        artifact.testPath.length > 0 &&
        artifact.testPath.length <= 4096 &&
        (artifact.testName === null ||
          (typeof artifact.testName === 'string' &&
            artifact.testName.length <= 500)) &&
        typeof artifact.createdAt === 'string' &&
        typeof artifact.success === 'boolean' &&
        Number.isFinite(artifact.durationMs) &&
        Array.isArray(artifact.assertions) &&
        artifact.assertions.length <= 10_000 &&
        artifact.assertions.every(
          (assertion) =>
            assertion &&
            typeof assertion.name === 'string' &&
            assertion.name.length <= 2_000 &&
            typeof assertion.status === 'string' &&
            assertion.status.length <= 100 &&
            (assertion.durationMs === null ||
              Number.isFinite(assertion.durationMs)) &&
            Array.isArray(assertion.failures) &&
            assertion.failures.length <= 100 &&
            assertion.failures.every(
              (failure) =>
                typeof failure === 'string' && failure.length <= 20_000,
            ),
        ),
    );
  const validSession =
    goal?.agentSession === null ||
    (goal?.agentSession &&
      typeof goal.agentSession.id === 'string' &&
      typeof goal.agentSession.provider === 'string' &&
      goal.agentSession.provider.length > 0 &&
      goal.agentSession.provider.length <= 100 &&
      typeof goal.agentSession.externalId === 'string' &&
      goal.agentSession.externalId.length > 0 &&
      goal.agentSession.externalId.length <= 500 &&
      goal.agentSession.metadata &&
      typeof goal.agentSession.metadata === 'object' &&
      typeof goal.agentSession.createdAt === 'string' &&
      typeof goal.agentSession.updatedAt === 'string');

  return Boolean(
    goal &&
      typeof goal.id === 'string' &&
      goal.id.length > 0 &&
      goal.id.length <= 100 &&
      typeof goal.title === 'string' &&
      goal.title.length > 0 &&
      goal.title.length <= 200 &&
      typeof goal.workingDirectory === 'string' &&
      goal.workingDirectory.length > 0 &&
      goal.workingDirectory.length <= 4096 &&
      path.isAbsolute(goal.workingDirectory) &&
      typeof goal.createdAt === 'string' &&
      typeof goal.updatedAt === 'string' &&
      (goal.findingsMarkdown === null ||
        (typeof goal.findingsMarkdown === 'string' &&
          goal.findingsMarkdown.length <= 500_000)) &&
      (goal.planMarkdown === null ||
        (typeof goal.planMarkdown === 'string' &&
          goal.planMarkdown.length <= 500_000)) &&
      validAuditArtifacts &&
      validSession &&
      // Tasks are deliberately not validated here: a goal save never writes a
      // task row, so the renderer does not send them.
      Array.isArray(goal.messages) &&
      goal.messages.length <= 10_000 &&
      goal.messages.every(
        (message) =>
          message &&
          typeof message.id === 'string' &&
          ['user', 'assistant'].includes(message.role) &&
          ['streaming', 'complete', 'cancelled', 'error'].includes(
            message.status,
          ) &&
          Array.isArray(message.parts),
      ),
  );
}

async function validatedDirectory(directory) {
  const resolvedDirectory = await realpath(directory);
  const directoryStat = await stat(resolvedDirectory);

  if (!directoryStat.isDirectory()) {
    throw new Error('The working directory is not a directory.');
  }

  return resolvedDirectory;
}

function readableClaudeError(error) {
  if (
    ['EACCES', 'ENOENT', 'ENOTDIR'].includes(error?.code) ||
    error?.message === 'The working directory is not a directory.'
  ) {
    return 'The selected working directory is no longer available.';
  }

  if (error?.code === 'CLI_NOT_FOUND') {
    return 'Claude CLI was not found. Install Claude Code or set CLAUDE_PATH to its executable.';
  }

  if (/auth|log.?in|credential/i.test(error?.message ?? '')) {
    return 'Claude CLI is not authenticated. Run `claude` in a terminal and configure your preferred authentication method.';
  }

  return 'Claude CLI could not complete the response. Try running `claude` in a terminal to check its status.';
}

function relativeToolInput(input, cwd) {
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

async function startClaudeRequest(event, request) {
  if (!isTrustedSender(event.senderFrame)) {
    return;
  }

  if (!isValidStartRequest(request)) {
    sendClaudeEvent(event.sender, {
      type: 'error',
      requestId: request?.requestId ?? '',
      message: 'The chat request was invalid.',
    });
    return;
  }

  if (activeRequests.has(event.sender.id)) {
    sendClaudeEvent(event.sender, {
      type: 'error',
      requestId: request.requestId,
      message: 'Wait for the current response to finish or stop it first.',
    });
    return;
  }

  const activeRequest = {
    requestId: request.requestId,
    cancelled: false,
    cancel: () => {},
  };
  activeRequests.set(event.sender.id, activeRequest);

  try {
    const cwd = await validatedDirectory(request.cwd);

    if (activeRequest.cancelled) {
      sendClaudeEvent(event.sender, {
        type: 'cancelled',
        requestId: request.requestId,
      });
      return;
    }

    const toolNames = new Map();
    const artifactMutationTools = new Set([
      'mcp__rba__add_test_trace',
      'mcp__rba__remove_artifact',
    ]);
    const stream = beginClaudeCli({
      prompt: request.prompt,
      sessionId: request.sessionId,
      cwd,
      goalDatabase,
      goalId: request.goalId,
      findingsServer: {
        command: process.execPath,
        script: path.join(__dirname, 'findings-mcp-server.js'),
        env: { ELECTRON_RUN_AS_NODE: '1' },
      },
      onText: (text) => {
        sendClaudeEvent(event.sender, {
          type: 'text-delta',
          requestId: request.requestId,
          text,
        });
      },
      onToolStart: (tool) => {
        toolNames.set(tool.id, tool.name);
        sendClaudeEvent(event.sender, {
          type: 'tool-start',
          requestId: request.requestId,
          tool,
        });
      },
      onToolInput: (tool) => {
        const toolName = toolNames.get(tool.id);
        sendClaudeEvent(event.sender, {
          type: 'tool-input',
          requestId: request.requestId,
          tool: {
            ...tool,
            input: artifactMutationTools.has(toolName)
              ? Object.fromEntries(
                  Object.entries(tool.input ?? {}).filter(
                    ([key]) => key !== 'content',
                  ),
                )
              : relativeToolInput(tool.input, cwd),
          },
        });
      },
      onToolResult: (tool) => {
        sendClaudeEvent(event.sender, {
          type: 'tool-result',
          requestId: request.requestId,
          tool,
        });
        if (
          !tool.isError &&
          artifactMutationTools.has(toolNames.get(tool.id))
        ) {
          sendClaudeEvent(event.sender, {
            type: 'audit-updated',
            requestId: request.requestId,
            artifacts: goalStore.get(request.goalId)?.auditArtifacts ?? [],
          });
        }
        toolNames.delete(tool.id);
      },
    });

    activeRequest.cancel = stream.cancel;

    const result = await stream.completion;

    if (activeRequest.cancelled) {
      sendClaudeEvent(event.sender, {
        type: 'cancelled',
        requestId: request.requestId,
      });
    } else {
      sendClaudeEvent(event.sender, {
        type: 'complete',
        requestId: request.requestId,
        sessionId: result.sessionId,
      });
    }
  } catch (error) {
    sendClaudeEvent(event.sender, {
      type: activeRequest?.cancelled ? 'cancelled' : 'error',
      requestId: request.requestId,
      ...(activeRequest?.cancelled
        ? {}
        : { message: readableClaudeError(error) }),
    });
  } finally {
    if (activeRequests.get(event.sender.id) === activeRequest) {
      activeRequests.delete(event.sender.id);
    }
  }
}

ipcMain.on('claude:start', (event, request) => {
  void startClaudeRequest(event, request);
});

ipcMain.on('claude:cancel', (event, requestId) => {
  if (!isTrustedSender(event.senderFrame)) {
    return;
  }

  const activeRequest = activeRequests.get(event.sender.id);

  if (activeRequest?.requestId === requestId) {
    activeRequest.cancelled = true;
    activeRequest.cancel();
  }
});

ipcMain.handle('claude:get-default-directory', async (event) => {
  if (!isTrustedSender(event.senderFrame)) {
    throw new Error('Untrusted directory request.');
  }

  return realpath(process.cwd());
});

ipcMain.handle('claude:pick-directory', async (event) => {
  if (!isTrustedSender(event.senderFrame)) {
    throw new Error('Untrusted directory request.');
  }

  const options = {
    defaultPath: process.cwd(),
    properties: ['openDirectory'],
  };
  const owner = BrowserWindow.fromWebContents(event.sender);
  const result = owner
    ? await dialog.showOpenDialog(owner, options)
    : await dialog.showOpenDialog(options);

  return result.canceled ? null : validatedDirectory(result.filePaths[0]);
});

ipcMain.handle('goals:list', (event) => {
  if (!isTrustedSender(event.senderFrame)) {
    throw new Error('Untrusted goal request.');
  }

  return goalStore.list();
});

ipcMain.handle('goals:get', (event, id) => {
  if (
    !isTrustedSender(event.senderFrame) ||
    typeof id !== 'string' ||
    id.length > 100
  ) {
    throw new Error('Invalid goal request.');
  }

  return goalStore.get(id);
});

ipcMain.handle('goals:save', (event, goal) => {
  if (!isTrustedSender(event.senderFrame) || !isValidGoal(goal)) {
    throw new Error('Invalid goal.');
  }

  goalStore.save(goal);
});

ipcMain.handle('goals:commit-tasks', (event, goalId) => {
  if (
    !isTrustedSender(event.senderFrame) ||
    typeof goalId !== 'string' ||
    goalId.length === 0 ||
    goalId.length > 100
  ) {
    throw new Error('Invalid task commit request.');
  }

  return goalStore.commitTasks(goalId);
});

ipcMain.handle('tasks:list', (event) => {
  if (!isTrustedSender(event.senderFrame)) {
    throw new Error('Untrusted task request.');
  }

  return goalStore.listCommittedTasks();
});

ipcMain.handle('workers:get', (event, taskId) => {
  if (
    !isTrustedSender(event.senderFrame) ||
    typeof taskId !== 'string' ||
    taskId.length === 0 ||
    taskId.length > 100
  ) {
    throw new Error('Invalid worker request.');
  }
  return goalStore.getWorkerRun(taskId);
});

ipcMain.handle('workers:start', async (event, taskId) => {
  if (
    !isTrustedSender(event.senderFrame) ||
    typeof taskId !== 'string' ||
    taskId.length === 0 ||
    taskId.length > 100
  ) {
    throw new Error('Invalid worker request.');
  }
  return workerService.start(taskId);
});

ipcMain.handle('workers:stop', (event, taskId) => {
  if (
    !isTrustedSender(event.senderFrame) ||
    typeof taskId !== 'string' ||
    taskId.length === 0 ||
    taskId.length > 100
  ) {
    throw new Error('Invalid worker request.');
  }
  return workerService.stop(taskId);
});

ipcMain.handle('workers:send', (event, taskId, prompt) => {
  if (
    !isTrustedSender(event.senderFrame) ||
    typeof taskId !== 'string' ||
    taskId.length === 0 ||
    taskId.length > 100 ||
    typeof prompt !== 'string' ||
    prompt.trim().length === 0 ||
    prompt.length > 100_000
  ) {
    throw new Error('Invalid worker message.');
  }
  return workerService.send(taskId, prompt.trim());
});

ipcMain.handle('workers:diff', (event, taskId) => {
  if (
    !isTrustedSender(event.senderFrame) ||
    typeof taskId !== 'string' ||
    taskId.length === 0 ||
    taskId.length > 100
  ) {
    throw new Error('Invalid worker diff request.');
  }
  return workerService.getDiff(taskId);
});

function validShortId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 200;
}

ipcMain.handle('workflows:list', async (event, taskId) => {
  if (!isTrustedSender(event.senderFrame) || !validShortId(taskId)) {
    throw new Error('Invalid workflow request.');
  }
  const task = goalStore.getTaskForWorker(taskId);
  if (!task) throw new Error('The task no longer exists.');
  return listWorkflows(task.workingDirectory);
});

ipcMain.handle('workflows:get', (event, taskId) => {
  if (!isTrustedSender(event.senderFrame) || !validShortId(taskId)) {
    throw new Error('Invalid workflow request.');
  }
  return workflowService.get(taskId);
});

ipcMain.handle('workflows:start', async (event, taskId, sourcePath) => {
  if (
    !isTrustedSender(event.senderFrame) ||
    !validShortId(taskId) ||
    typeof sourcePath !== 'string'
  ) {
    throw new Error('Invalid workflow request.');
  }
  const task = goalStore.getTaskForWorker(taskId);
  if (!task) throw new Error('The task no longer exists.');
  const workflows = await listWorkflows(task.workingDirectory);
  if (!workflows.some((workflow) => workflow.path === sourcePath)) {
    throw new Error('The selected workflow is outside this project.');
  }
  return workflowService.start(taskId, sourcePath);
});

ipcMain.handle('workflows:resolve', (event, runId, key, value) => {
  if (
    !isTrustedSender(event.senderFrame) ||
    !validShortId(runId) ||
    !validShortId(key) ||
    JSON.stringify(value).length > 100_000
  ) {
    throw new Error('Invalid workflow input.');
  }
  return workflowService.resolveHuman(runId, key, value);
});

ipcMain.handle('workflows:stop', (event, runId) => {
  if (!isTrustedSender(event.senderFrame) || !validShortId(runId)) {
    throw new Error('Invalid workflow request.');
  }
  return workflowService.stop(runId);
});

ipcMain.handle('workflows:diff', (event, taskId) => {
  if (!isTrustedSender(event.senderFrame) || !validShortId(taskId)) {
    throw new Error('Invalid workflow request.');
  }
  return workflowService.getDiff(taskId);
});

function createWindow() {
  const window = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
      sandbox: true,
    },
  });

  const webContentsId = window.webContents.id;
  window.webContents.once('destroyed', () => {
    activeRequests.get(webContentsId)?.cancel();
    activeRequests.delete(webContentsId);
  });

  const developmentUrl = process.env.VITE_DEV_SERVER_URL;

  if (developmentUrl) {
    window.loadURL(developmentUrl);
  } else {
    window.loadFile(path.join(__dirname, 'dist', 'index.html'));
  }
}

app.whenReady().then(() => {
  goalDatabase = path.join(app.getPath('userData'), 'goals.sqlite3');
  goalStore = new GoalStore(goalDatabase);
  goalStore.interruptWorkingRuns();
  workflowStore = new WorkflowStore(goalStore.database);
  const resumableWorkflows = workflowStore.recoverInterruptedRuns();
  workerService = new WorkerService({
    store: goalStore,
    worktreesDirectory: path.join(app.getPath('userData'), 'worktrees'),
    onUpdate: broadcastWorker,
  });
  workflowService = new WorkflowService({
    store: workflowStore,
    taskStore: goalStore,
    worktreesDirectory: path.join(
      app.getPath('userData'),
      'workflow-worktrees',
    ),
    onUpdate: broadcastWorkflow,
  });
  for (const run of resumableWorkflows) workflowService.resume(run);
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('will-quit', () => {
  workflowService?.shutdown();
  workerService?.shutdown();
  goalStore?.close();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
