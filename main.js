const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const { realpath, stat } = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { beginClaudeCli } = require('./claude-cli-service');
const { GoalStore } = require('./goal-store');
const { WorkerService } = require('./worker-service');

const activeRequests = new Map();
let goalStore;
let goalDatabase;
let workerService;

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
    const pendingFindings = new Map();
    const taskMutationTools = new Set([
      'mcp__rba__add_task',
      'mcp__rba__update_task',
      'mcp__rba__remove_task',
      'mcp__rba__commit_tasks',
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
        if (
          toolName === 'mcp__rba__update_findings' &&
          typeof tool.input?.markdown === 'string' &&
          tool.input.markdown.length <= 500_000
        ) {
          pendingFindings.set(tool.id, tool.input.markdown);
        }
        sendClaudeEvent(event.sender, {
          type: 'tool-input',
          requestId: request.requestId,
          tool: {
            ...tool,
            input:
              toolName === 'mcp__rba__update_findings'
                ? {}
                : taskMutationTools.has(toolName)
                  ? Object.fromEntries(
                      Object.entries(tool.input ?? {}).filter(
                        ([key]) => key !== 'specMarkdown',
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
        const markdown = pendingFindings.get(tool.id);
        if (!tool.isError && markdown !== undefined) {
          sendClaudeEvent(event.sender, {
            type: 'findings-updated',
            requestId: request.requestId,
            markdown,
          });
        }
        if (!tool.isError && taskMutationTools.has(toolNames.get(tool.id))) {
          sendClaudeEvent(event.sender, {
            type: 'tasks-updated',
            requestId: request.requestId,
            tasks: goalStore.listTasks(request.goalId),
          });
        }
        pendingFindings.delete(tool.id);
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
  workerService = new WorkerService({
    store: goalStore,
    worktreesDirectory: path.join(app.getPath('userData'), 'worktrees'),
    onUpdate: broadcastWorker,
  });
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('will-quit', () => {
  workerService?.shutdown();
  goalStore?.close();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
