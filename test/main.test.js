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
