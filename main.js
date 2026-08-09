const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { beginClaudeCli } = require('./claude-cli-service');

const activeRequests = new Map();
const sessionIds = new Map();

function sendClaudeEvent(webContents, payload) {
  if (!webContents.isDestroyed()) {
    webContents.send('claude:event', payload);
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
      typeof request.prompt === 'string' &&
      request.prompt.trim().length > 0 &&
      request.prompt.length <= 100_000,
  );
}

function readableClaudeError(error) {
  if (error?.code === 'CLI_NOT_FOUND') {
    return 'Claude CLI was not found. Install Claude Code or set CLAUDE_PATH to its executable.';
  }

  if (/auth|log.?in|credential/i.test(error?.message ?? '')) {
    return 'Claude CLI is not authenticated. Run `claude` in a terminal and configure your preferred authentication method.';
  }

  return 'Claude CLI could not complete the response. Try running `claude` in a terminal to check its status.';
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

  let activeRequest;

  try {
    const stream = beginClaudeCli({
      prompt: request.prompt,
      sessionId: sessionIds.get(event.sender.id),
      cwd: process.cwd(),
      onText: (text) => {
        sendClaudeEvent(event.sender, {
          type: 'text-delta',
          requestId: request.requestId,
          text,
        });
      },
    });

    activeRequest = {
      requestId: request.requestId,
      cancelled: false,
      cancel: stream.cancel,
    };
    activeRequests.set(event.sender.id, activeRequest);

    const result = await stream.completion;

    if (activeRequest.cancelled) {
      sendClaudeEvent(event.sender, {
        type: 'cancelled',
        requestId: request.requestId,
      });
    } else {
      sessionIds.set(event.sender.id, result.sessionId);
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
    sessionIds.delete(webContentsId);
  });

  const developmentUrl = process.env.VITE_DEV_SERVER_URL;

  if (developmentUrl) {
    window.loadURL(developmentUrl);
  } else {
    window.loadFile(path.join(__dirname, 'dist', 'index.html'));
  }
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
