const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { test } = require('node:test');

delete process.env.VITE_DEV_SERVER_URL;

const rendererUrl = pathToFileURL(
  path.join(__dirname, '..', 'dist', 'index.html'),
).href;

function makeElectronMock() {
  const ipcOnHandlers = new Map();
  const ipcHandleHandlers = new Map();

  return {
    mock: {
      app: {
        whenReady: () => new Promise(() => {}),
        getPath: () => '/tmp/rba-test',
        on: () => {},
        quit: () => {},
      },
      BrowserWindow: class {
        static getAllWindows() {
          return [];
        }
        static fromWebContents() {
          return null;
        }
      },
      dialog: {
        showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
      },
      ipcMain: {
        on: (channel, handler) => {
          ipcOnHandlers.set(channel, handler);
        },
        handle: (channel, handler) => {
          ipcHandleHandlers.set(channel, handler);
        },
      },
      protocol: {
        registerSchemesAsPrivileged: () => {},
        handle: () => {},
      },
    },
    ipcOnHandlers,
    ipcHandleHandlers,
  };
}

function loadMainWithMocks({ beginClaudeCli }) {
  const { mock: electronMock, ipcOnHandlers } = makeElectronMock();

  const mocks = {
    electron: electronMock,
    './goal-store': { GoalStore: class {} },
    './worker-service': { WorkerService: class {} },
    './claude-cli-service': { beginClaudeCli },
  };

  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (Object.hasOwn(mocks, request)) {
      return mocks[request];
    }
    return originalLoad.apply(this, arguments);
  };

  const mainPath = require.resolve('../main.js');
  delete require.cache[mainPath];

  try {
    require('../main.js');
  } finally {
    Module._load = originalLoad;
  }

  return ipcOnHandlers;
}

/** Unlike loadMainWithMocks (used by the claude:start/cancel tests above),
 * this resolves app.whenReady() immediately with working goalStore /
 * workflowService fakes, so ipcMain.handle('workflows:*', ...) handlers can
 * be exercised end to end. */
function loadMainReadyWithMocks({ workflows = {} } = {}) {
  const ipcOnHandlers = new Map();
  const ipcHandleHandlers = new Map();
  const windows = [];

  const workflowServiceCalls = [];
  let workflowServiceInstance;
  const fakeWorkflowService = {
    start: async (id, options) => {
      workflowServiceCalls.push({ method: 'start', id, options });
      return workflows.startResult ?? { id: 'run-1', status: 'running' };
    },
    stop: (runId) => {
      workflowServiceCalls.push({ method: 'stop', runId });
      return { id: runId, status: 'stopped' };
    },
    shutdown: () => {},
  };

  const electronMock = {
    app: {
      whenReady: () => Promise.resolve(),
      getPath: () => '/tmp/rba-test',
      on: () => {},
      quit: () => {},
    },
    BrowserWindow: class {
      constructor() {
        this.webContents = {
          id: 1,
          isDestroyed: () => false,
          once: () => {},
          send: () => {},
        };
      }
      loadURL() {}
      loadFile() {}
      static getAllWindows() {
        return windows;
      }
      static fromWebContents() {
        return null;
      }
    },
    dialog: {
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    },
    ipcMain: {
      on: (channel, handler) => {
        ipcOnHandlers.set(channel, handler);
      },
      handle: (channel, handler) => {
        ipcHandleHandlers.set(channel, handler);
      },
    },
    protocol: {
      registerSchemesAsPrivileged: () => {},
      handle: () => {},
    },
  };

  const mocks = {
    electron: electronMock,
    './goal-store': {
      GoalStore: class {
        interruptWorkingRuns() {}
        getArtifact() {
          return null;
        }
      },
    },
    './worker-service': { WorkerService: class {} },
    './workflow-service': {
      WorkflowService: class {
        constructor(options) {
          Object.assign(this, fakeWorkflowService);
          this.onUpdate = options.onUpdate;
          workflowServiceInstance = this;
        }
      },
    },
    './claude-cli-service': { beginClaudeCli: () => ({}) },
  };

  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (Object.hasOwn(mocks, request)) {
      return mocks[request];
    }
    return originalLoad.apply(this, arguments);
  };

  const mainPath = require.resolve('../main.js');
  delete require.cache[mainPath];

  try {
    require('../main.js');
  } finally {
    Module._load = originalLoad;
  }

  return {
    ipcHandleHandlers,
    windows,
    workflowServiceCalls,
    getWorkflowServiceInstance: () => workflowServiceInstance,
  };
}

function fakeEvent(senderId) {
  return {
    senderFrame: { url: rendererUrl },
    sender: {
      id: senderId,
      send: () => {},
      isDestroyed: () => false,
    },
  };
}

function baseRequest(overrides) {
  return {
    requestId: 'req-1',
    goalId: 'goal-1',
    prompt: 'hello',
    cwd: __dirname,
    ...overrides,
  };
}

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function waitFor(predicate, timeoutMs = 1000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor timed out');
    }
    await flush();
  }
}

function deferred() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

test('rejects a second in-flight request for the same goal', async () => {
  const pending = deferred();
  const beginClaudeCli = () => ({
    cancel: () => {},
    completion: pending.promise,
  });

  const ipcOnHandlers = loadMainWithMocks({ beginClaudeCli });
  const startHandler = ipcOnHandlers.get('claude:start');

  const event = fakeEvent(1);
  const sent = [];
  event.sender.send = (channel, payload) => sent.push(payload);

  startHandler(event, baseRequest({ requestId: 'req-1' }));
  await flush();
  await flush();

  startHandler(event, baseRequest({ requestId: 'req-2' }));
  await Promise.resolve();

  const rejection = sent.find(
    (payload) => payload.requestId === 'req-2' && payload.type === 'error',
  );
  assert.ok(rejection, 'expected the second same-goal request to be rejected');
  assert.match(rejection.message, /Wait for the current response/);

  pending.resolve({ sessionId: 'session-1' });
});

test('allows concurrent in-flight requests for different goals', async () => {
  const pendingA = deferred();
  const pendingB = deferred();
  const calls = [];
  const beginClaudeCli = ({ goalId }) => {
    calls.push(goalId);
    return {
      cancel: () => {},
      completion: goalId === 'goal-a' ? pendingA.promise : pendingB.promise,
    };
  };

  const ipcOnHandlers = loadMainWithMocks({ beginClaudeCli });
  const startHandler = ipcOnHandlers.get('claude:start');

  const event = fakeEvent(1);
  const sent = [];
  event.sender.send = (channel, payload) => sent.push(payload);

  startHandler(event, baseRequest({ requestId: 'req-a', goalId: 'goal-a' }));
  await waitFor(() => calls.length >= 1);

  startHandler(event, baseRequest({ requestId: 'req-b', goalId: 'goal-b' }));
  await waitFor(() => calls.length >= 2);

  const rejections = sent.filter((payload) => payload.type === 'error');
  assert.equal(rejections.length, 0, 'neither goal should be rejected');
  assert.deepEqual(calls.sort(), ['goal-a', 'goal-b']);

  pendingA.resolve({ sessionId: 'session-a' });
  pendingB.resolve({ sessionId: 'session-b' });
});

test('cancelling one goal does not cancel another goal in-flight request', async () => {
  const pendingA = deferred();
  const pendingB = deferred();
  const cancelledGoals = [];
  const calls = [];
  const beginClaudeCli = ({ goalId }) => {
    calls.push(goalId);
    return {
      cancel: () => cancelledGoals.push(goalId),
      completion: goalId === 'goal-a' ? pendingA.promise : pendingB.promise,
    };
  };

  const ipcOnHandlers = loadMainWithMocks({ beginClaudeCli });
  const startHandler = ipcOnHandlers.get('claude:start');
  const cancelHandler = ipcOnHandlers.get('claude:cancel');

  const event = fakeEvent(1);
  event.sender.send = () => {};

  startHandler(event, baseRequest({ requestId: 'req-a', goalId: 'goal-a' }));
  await waitFor(() => calls.length >= 1);

  startHandler(event, baseRequest({ requestId: 'req-b', goalId: 'goal-b' }));
  await waitFor(() => calls.length >= 2);

  cancelHandler(event, 'req-a', 'goal-a');

  assert.deepEqual(cancelledGoals, ['goal-a']);

  pendingA.resolve({ sessionId: 'session-a' });
  pendingB.resolve({ sessionId: 'session-b' });
});

function fakeWorkflowWindow(sent) {
  return {
    webContents: {
      isDestroyed: () => false,
      send: (channel, payload) => sent.push({ channel, payload }),
    },
  };
}

test('workflows:start rejects untrusted senders', async () => {
  const { ipcHandleHandlers } = loadMainReadyWithMocks();
  await flush();
  const handler = ipcHandleHandlers.get('workflows:start');
  const event = { senderFrame: { url: 'https://evil.example' } };
  await assert.rejects(async () => handler(event, 'workflow-1', {}));
});

test('workflows:start rejects malformed arguments', async () => {
  const { ipcHandleHandlers } = loadMainReadyWithMocks();
  await flush();
  const handler = ipcHandleHandlers.get('workflows:start');
  const event = fakeEvent(1);

  await assert.rejects(async () => handler(event, '', {}));
  await assert.rejects(async () =>
    handler(event, 'workflow-1', { fresh: 'yes' }),
  );
  await assert.rejects(async () =>
    handler(event, 'workflow-1', { directory: 123 }),
  );
});

test('workflows:start forwards resolved options to the workflow service', async () => {
  const { ipcHandleHandlers, workflowServiceCalls } = loadMainReadyWithMocks();
  await flush();
  const handler = ipcHandleHandlers.get('workflows:start');
  const event = fakeEvent(1);

  const result = await handler(event, 'workflow-1', {
    directory: '/workspace',
    fresh: true,
  });

  assert.equal(result.id, 'run-1');
  assert.deepEqual(workflowServiceCalls, [
    {
      method: 'start',
      id: 'workflow-1',
      options: { directory: '/workspace', fresh: true },
    },
  ]);
});

test('the workflow update callback broadcasts to all windows', async () => {
  const { getWorkflowServiceInstance, windows } = loadMainReadyWithMocks();
  await flush();
  const sent = [];
  windows.push(fakeWorkflowWindow(sent), fakeWorkflowWindow(sent));

  const run = { id: 'run-1', status: 'completed' };
  getWorkflowServiceInstance().onUpdate(run);

  assert.equal(sent.length, 2);
  assert.deepEqual(sent[0].payload, { type: 'run-updated', run });
  assert.equal(sent[0].channel, 'workflows:event');
});
