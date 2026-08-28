const { app, BrowserWindow, dialog, ipcMain, protocol } = require('electron');
const { execFile } = require('node:child_process');
const { realpath, stat } = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { promisify } = require('node:util');
const { beginClaudeCli } = require('./claude-cli-service');
const { GoalStore } = require('./goal-store');
const { WorkerService } = require('./worker-service');
const { WorkflowService } = require('./workflow-service');
const { validateDefinition, normaliseDefinition } = require('./workflow-spec');

const execFileAsync = promisify(execFile);

const activeRequests = new Map();
let goalStore;
let goalDatabase;
let workerService;
let workflowService;

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'rba-artifact',
    privileges: { standard: true, secure: true },
  },
]);

function artifactResponse(status, body) {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy':
        "default-src 'none'; style-src 'unsafe-inline' https:; script-src 'unsafe-inline' https:; img-src data: https:; font-src data: https:; connect-src https:; media-src data: https:",
    },
  });
}

function registerArtifactProtocol() {
  protocol.handle('rba-artifact', (request) => {
    const url = new URL(request.url);
    const id = decodeURIComponent(url.pathname.slice(1));
    if (url.hostname !== 'artifact' || !id || id.length > 100) {
      return artifactResponse(400, '<h1>Invalid artifact</h1>');
    }
    const artifact = goalStore.getArtifact(id);
    return artifact
      ? artifactResponse(200, artifact.html)
      : artifactResponse(404, '<h1>Artifact not found</h1>');
  });
}

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
        type: 'run-updated',
        run,
      });
    }
  }
}

function broadcastTaskDeleted(taskId) {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.webContents.isDestroyed()) {
      window.webContents.send('workers:event', {
        type: 'task-deleted',
        taskId,
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

  const activeRequestKey = `${event.sender.id}:${request.goalId}`;

  if (activeRequests.has(activeRequestKey)) {
    sendClaudeEvent(event.sender, {
      type: 'error',
      requestId: request.requestId,
      message: 'Wait for the current response to finish or stop it first.',
    });
    return;
  }

  const activeRequest = {
    requestId: request.requestId,
    goalId: request.goalId,
    cancelled: false,
    cancel: () => {},
  };
  activeRequests.set(activeRequestKey, activeRequest);

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
      'mcp__rba__create_artifact',
      'mcp__rba__update_artifact',
      'mcp__rba__remove_artifact',
    ]);
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
      model: goalStore?.getSettings().plannerModel ?? 'sonnet',
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
                    ([key]) => key !== 'html',
                  ),
                )
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
        if (
          !tool.isError &&
          artifactMutationTools.has(toolNames.get(tool.id))
        ) {
          sendClaudeEvent(event.sender, {
            type: 'artifacts-updated',
            requestId: request.requestId,
            artifacts: goalStore.listArtifacts(request.goalId),
          });
        }
        if (!tool.isError && taskMutationTools.has(toolNames.get(tool.id))) {
          sendClaudeEvent(event.sender, {
            type: 'tasks-updated',
            requestId: request.requestId,
            tasks: goalStore.listTasks(request.goalId),
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
    if (activeRequests.get(activeRequestKey) === activeRequest) {
      activeRequests.delete(activeRequestKey);
    }
  }
}

ipcMain.on('claude:start', (event, request) => {
  void startClaudeRequest(event, request);
});

ipcMain.on('claude:cancel', (event, requestId, goalId) => {
  if (!isTrustedSender(event.senderFrame)) {
    return;
  }

  const activeRequest = activeRequests.get(`${event.sender.id}:${goalId}`);

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

ipcMain.handle('goals:mark-read', (event, goalId) => {
  if (
    !isTrustedSender(event.senderFrame) ||
    typeof goalId !== 'string' ||
    goalId.length === 0 ||
    goalId.length > 100
  ) {
    throw new Error('Invalid goal request.');
  }

  goalStore.markRead(goalId);
});

ipcMain.handle('goals:mark-unread', (event, goalId) => {
  if (
    !isTrustedSender(event.senderFrame) ||
    typeof goalId !== 'string' ||
    goalId.length === 0 ||
    goalId.length > 100
  ) {
    throw new Error('Invalid goal request.');
  }

  goalStore.markUnread(goalId);
});

ipcMain.handle('goals:rename', (event, goalId, title) => {
  if (
    !isTrustedSender(event.senderFrame) ||
    typeof goalId !== 'string' ||
    goalId.length === 0 ||
    goalId.length > 100 ||
    typeof title !== 'string' ||
    title.trim().length === 0 ||
    title.length > 200
  ) {
    throw new Error('Invalid goal rename request.');
  }

  goalStore.renameGoal(goalId, title.trim());
});

ipcMain.handle('goals:complete', (event, goalId) => {
  if (
    !isTrustedSender(event.senderFrame) ||
    typeof goalId !== 'string' ||
    goalId.length === 0 ||
    goalId.length > 100
  ) {
    throw new Error('Invalid goal request.');
  }

  goalStore.completeGoal(goalId);
});

ipcMain.handle('goals:reopen', (event, goalId) => {
  if (
    !isTrustedSender(event.senderFrame) ||
    typeof goalId !== 'string' ||
    goalId.length === 0 ||
    goalId.length > 100
  ) {
    throw new Error('Invalid goal request.');
  }

  goalStore.reopenGoal(goalId);
});

ipcMain.handle('goals:delete', async (event, goalId) => {
  if (
    !isTrustedSender(event.senderFrame) ||
    typeof goalId !== 'string' ||
    goalId.length === 0 ||
    goalId.length > 100
  ) {
    throw new Error('Invalid goal request.');
  }

  const goal = goalStore.get(goalId);
  if (!goal) {
    throw new Error('This goal no longer exists.');
  }

  const startedTasks = goal.tasks.some(
    (task) => !['draft', 'queued'].includes(task.status),
  );

  if (startedTasks) {
    const window = BrowserWindow.fromWebContents(event.sender);
    const { response } = await dialog.showMessageBox(window, {
      type: 'warning',
      buttons: ['Cancel', 'Delete task'],
      cancelId: 0,
      defaultId: 0,
      message: goal.title,
      detail:
        'Deletes worktrees and branches for its started tasks. This cannot be undone.',
    });
    if (response === 0) {
      return;
    }
  }

  await workerService.deleteGoal(goalId);
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

ipcMain.handle('tasks:delete', async (event, taskId) => {
  if (
    !isTrustedSender(event.senderFrame) ||
    typeof taskId !== 'string' ||
    taskId.length === 0 ||
    taskId.length > 100
  ) {
    throw new Error('Invalid task request.');
  }

  const run = goalStore.getWorkerRun(taskId);
  const task = goalStore.getTaskForWorker(taskId);
  if (!task) {
    throw new Error('This task no longer exists.');
  }

  let detail = 'This cannot be undone.';
  if (run?.worktree) {
    detail = `Deletes branch ${run.branch} and its worktree. This cannot be undone.`;
    try {
      const { stdout } = await execFileAsync(
        'git',
        ['-C', run.worktree, 'status', '--porcelain'],
        { encoding: 'utf8' },
      );
      const changedFiles = stdout.split('\n').filter(Boolean).length;
      detail = `Deletes branch ${run.branch} and its worktree, including ${changedFiles} uncommitted files. This cannot be undone.`;
    } catch {
      // Fall back to the generic wording above.
    }
  }

  const window = BrowserWindow.fromWebContents(event.sender);
  const { response } = await dialog.showMessageBox(window, {
    type: 'warning',
    buttons: ['Cancel', 'Delete task'],
    cancelId: 0,
    defaultId: 0,
    message: task.title,
    detail,
  });
  if (response === 0) {
    return { deleted: false };
  }

  await workerService.deleteTask(taskId);
  broadcastTaskDeleted(taskId);
  return { deleted: true };
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

ipcMain.handle('workers:complete', async (event, taskId) => {
  if (
    !isTrustedSender(event.senderFrame) ||
    typeof taskId !== 'string' ||
    taskId.length === 0 ||
    taskId.length > 100
  ) {
    throw new Error('Invalid worker request.');
  }
  await workerService.completeTask(taskId);
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

const AVAILABLE_MODEL_IDS = new Set(['fable', 'opus', 'sonnet', 'haiku']);

function isValidSettingsPatch(patch) {
  return Boolean(
    patch &&
      typeof patch === 'object' &&
      (patch.plannerModel === undefined ||
        AVAILABLE_MODEL_IDS.has(patch.plannerModel)) &&
      (patch.workerModel === undefined ||
        AVAILABLE_MODEL_IDS.has(patch.workerModel)),
  );
}

ipcMain.handle('settings:get', (event) => {
  if (!isTrustedSender(event.senderFrame)) {
    throw new Error('Untrusted settings request.');
  }

  return goalStore.getSettings();
});

ipcMain.handle('settings:set', (event, patch) => {
  if (!isTrustedSender(event.senderFrame) || !isValidSettingsPatch(patch)) {
    throw new Error('Invalid settings update.');
  }

  return goalStore.updateSettings(patch);
});

function isValidWorkflowDefinition(definition) {
  return Boolean(
    definition &&
      typeof definition === 'object' &&
      typeof definition.start === 'string' &&
      definition.steps &&
      typeof definition.steps === 'object',
  );
}

ipcMain.handle('workflows:list', (event) => {
  if (!isTrustedSender(event.senderFrame)) {
    throw new Error('Untrusted workflow request.');
  }
  return goalStore.listWorkflows();
});

ipcMain.handle('workflows:get', (event, id) => {
  if (
    !isTrustedSender(event.senderFrame) ||
    typeof id !== 'string' ||
    id.length === 0 ||
    id.length > 100
  ) {
    throw new Error('Invalid workflow request.');
  }
  return goalStore.getWorkflow(id);
});

ipcMain.handle('workflows:run-get', (event, runId) => {
  if (
    !isTrustedSender(event.senderFrame) ||
    typeof runId !== 'string' ||
    runId.length === 0 ||
    runId.length > 100
  ) {
    throw new Error('Invalid workflow run request.');
  }
  return goalStore.getWorkflowRun(runId);
});

ipcMain.handle('workflows:start', (event, id, options) => {
  if (
    !isTrustedSender(event.senderFrame) ||
    typeof id !== 'string' ||
    id.length === 0 ||
    id.length > 100 ||
    (options !== undefined &&
      (typeof options !== 'object' ||
        options === null ||
        (options.directory !== undefined &&
          (typeof options.directory !== 'string' ||
            options.directory.length === 0 ||
            options.directory.length > 4096)) ||
        (options.fresh !== undefined && typeof options.fresh !== 'boolean')))
  ) {
    throw new Error('Invalid workflow start request.');
  }
  return workflowService.start(id, {
    directory: options?.directory,
    fresh: options?.fresh,
  });
});

ipcMain.handle('workflows:stop', (event, runId) => {
  if (
    !isTrustedSender(event.senderFrame) ||
    typeof runId !== 'string' ||
    runId.length === 0 ||
    runId.length > 100
  ) {
    throw new Error('Invalid workflow stop request.');
  }
  return workflowService.stop(runId);
});

ipcMain.handle('workflows:delete', (event, id) => {
  if (
    !isTrustedSender(event.senderFrame) ||
    typeof id !== 'string' ||
    id.length === 0 ||
    id.length > 100
  ) {
    throw new Error('Invalid workflow request.');
  }
  goalStore.deleteWorkflow(id);
});

ipcMain.handle('workflows:save', (event, request) => {
  if (
    !isTrustedSender(event.senderFrame) ||
    !request ||
    typeof request !== 'object' ||
    typeof request.name !== 'string' ||
    request.name.length === 0 ||
    request.name.length > 64 ||
    (request.description !== undefined &&
      request.description !== null &&
      typeof request.description !== 'string') ||
    (request.directory !== undefined &&
      request.directory !== null &&
      typeof request.directory !== 'string') ||
    !isValidWorkflowDefinition(request.definition)
  ) {
    throw new Error('Invalid workflow.');
  }

  const definition = normaliseDefinition(request.definition);
  const validation = validateDefinition(definition);
  if (!validation.ok) {
    throw new Error(validation.errors.join(' '));
  }

  if (request.id) {
    return goalStore.updateWorkflow(request.id, {
      description: request.description ?? null,
      directory: request.directory ?? null,
      definition,
    });
  }
  return goalStore.createWorkflow({
    name: request.name,
    description: request.description ?? null,
    directory: request.directory ?? null,
    definition,
  });
});

ipcMain.handle('workflows:pick-directory', async (event) => {
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
    const prefix = `${webContentsId}:`;
    for (const [key, activeRequest] of activeRequests) {
      if (key.startsWith(prefix)) {
        activeRequest.cancel();
        activeRequests.delete(key);
      }
    }
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
  registerArtifactProtocol();
  goalStore.interruptWorkingRuns();
  workerService = new WorkerService({
    store: goalStore,
    worktreesDirectory: path.join(app.getPath('userData'), 'worktrees'),
    onUpdate: broadcastWorker,
  });
  workflowService = new WorkflowService({
    store: goalStore,
    onUpdate: broadcastWorkflow,
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
  workflowService?.shutdown();
  goalStore?.close();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
