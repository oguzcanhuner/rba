const assert = require('node:assert/strict');
const { setImmediate: waitForImmediate } = require('node:timers/promises');
const { test } = require('node:test');
const { GoalStore } = require('../goal-store');
const { WorkerService } = require('../worker-service');

function storeWithQueuedTask() {
  const store = new GoalStore(':memory:');
  store.save({
    id: 'goal-1',
    title: 'Build workers',
    workingDirectory: '/repo',
    agentSession: null,
    findingsMarkdown: '# Findings\n\nKeep it small.',
    tasks: [],
    messages: [],
    createdAt: '2026-08-09T10:00:00.000Z',
    updatedAt: '2026-08-09T10:00:00.000Z',
  });
  store.database
    .prepare(`
      INSERT INTO tasks (
        id, goal_id, sequence, title, spec_markdown, status,
        created_at, updated_at
      ) VALUES (?, ?, 1, ?, ?, 'queued', ?, ?)
    `)
    .run(
      'task-1',
      'goal-1',
      'Implement the worker',
      'Add the minimal worker.',
      '2026-08-09T10:01:00.000Z',
      '2026-08-09T10:01:00.000Z',
    );
  return store;
}

test('runs a queued task in a worktree and persists streamed activity', async () => {
  const store = storeWithQueuedTask();
  const commands = [];
  let callbacks;
  let finish;
  const completion = new Promise((resolve) => {
    finish = resolve;
  });
  const updates = [];
  const service = new WorkerService({
    store,
    worktreesDirectory: '/worker-root',
    makeDirectory: async () => {},
    runCommand: async (command, args) => {
      commands.push({ command, args });
      return {
        stdout: args.at(-1) === '--show-toplevel' ? '/repo\n' : 'abc123\n',
      };
    },
    beginWorker: (options) => {
      callbacks = options;
      return { cancel: () => {}, completion };
    },
    onUpdate: (run) => updates.push(run),
  });

  const started = await service.start('task-1');
  assert.equal(started.status, 'working');
  assert.equal(started.worktree, '/worker-root/task-1');
  assert.match(callbacks.prompt, /Implement the worker/);
  assert.match(callbacks.prompt, /Keep it small/);
  assert.deepEqual(commands.at(-1), {
    command: 'git',
    args: [
      '-C',
      '/repo',
      'worktree',
      'add',
      '-b',
      'rba/task-1',
      '/worker-root/task-1',
      'abc123',
    ],
  });

  callbacks.onText('I am working.');
  callbacks.onToolStart({ id: 'tool-1', name: 'Read' });
  callbacks.onToolInput({
    id: 'tool-1',
    input: { file_path: '/worker-root/task-1/main.js' },
  });
  callbacks.onToolResult({ id: 'tool-1', isError: false });
  finish({ sessionId: 'session-1' });
  await waitForImmediate();

  const completed = store.getWorkerRun('task-1');
  assert.equal(completed.status, 'completed');
  assert.equal(completed.sessionId, 'session-1');
  assert.equal(completed.messages[0].status, 'complete');
  assert.equal(completed.messages[0].parts[0].text, 'I am working.');
  assert.equal(completed.messages[0].parts[1].tool.input.file_path, 'main.js');
  assert.equal(completed.messages[0].parts[1].tool.status, 'complete');
  assert.equal(updates.at(-1).status, 'completed');
  store.close();
});

test('stops a running worker', async () => {
  const store = storeWithQueuedTask();
  let cancelled = false;
  const service = new WorkerService({
    store,
    worktreesDirectory: '/worker-root',
    makeDirectory: async () => {},
    runCommand: async (_command, args) => ({
      stdout: args.at(-1) === '--show-toplevel' ? '/repo\n' : 'abc123\n',
    }),
    beginWorker: () => ({
      cancel: () => {
        cancelled = true;
      },
      completion: new Promise(() => {}),
    }),
  });

  await service.start('task-1');
  const stopped = service.stop('task-1');

  assert.equal(cancelled, true);
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.messages[0].status, 'cancelled');
  store.close();
});

test('resumes a completed worker with a persisted user message', async () => {
  const store = storeWithQueuedTask();
  const turns = [];
  const completions = [];
  const service = new WorkerService({
    store,
    worktreesDirectory: '/worker-root',
    makeDirectory: async () => {},
    runCommand: async (_command, args) => ({
      stdout: args.at(-1) === '--show-toplevel' ? '/repo\n' : 'abc123\n',
    }),
    beginWorker: (options) => {
      turns.push(options);
      let finish;
      const completion = new Promise((resolve) => {
        finish = resolve;
      });
      completions.push(finish);
      return { cancel: () => {}, completion };
    },
  });

  await service.start('task-1');
  completions[0]({ sessionId: 'session-1' });
  await waitForImmediate();

  const responding = service.send('task-1', 'Please rename the helper.');
  assert.equal(responding.status, 'working');
  assert.equal(turns[1].prompt, 'Please rename the helper.');
  assert.equal(turns[1].sessionId, 'session-1');
  assert.deepEqual(
    responding.messages.map((message) => message.role),
    ['assistant', 'user', 'assistant'],
  );
  turns[1].onText('Done.');
  completions[1]({ sessionId: 'session-1' });
  await waitForImmediate();

  const completed = store.getWorkerRun('task-1');
  assert.equal(completed.status, 'completed');
  assert.equal(completed.messages[2].parts[0].text, 'Done.');
  store.close();
});

test('returns tracked and untracked worker changes from the base revision', async () => {
  const store = storeWithQueuedTask();
  let finish;
  const service = new WorkerService({
    store,
    worktreesDirectory: '/worker-root',
    makeDirectory: async () => {},
    runCommand: async (_command, args) => {
      if (args.includes('--show-toplevel')) {
        return { stdout: '/repo\n' };
      }
      if (args.at(-1) === 'HEAD') {
        return { stdout: 'abc123\n' };
      }
      if (args.includes('ls-files')) {
        return { stdout: 'new.js\0' };
      }
      if (args.includes('--no-index')) {
        throw Object.assign(new Error('Changes found'), {
          code: 1,
          stdout:
            'diff --git a/new.js b/new.js\n--- /dev/null\n+++ b/new.js\n@@ -0,0 +1 @@\n+new\n',
        });
      }
      if (args.includes('diff')) {
        assert.equal(args.includes('abc123'), true);
        return {
          stdout:
            'diff --git a/main.js b/main.js\n--- a/main.js\n+++ b/main.js\n@@ -1 +1 @@\n-old\n+new\n',
        };
      }
      return { stdout: '' };
    },
    beginWorker: () => ({
      cancel: () => {},
      completion: new Promise((resolve) => {
        finish = resolve;
      }),
    }),
  });

  await service.start('task-1');
  const diff = await service.getDiff('task-1');

  assert.match(diff.patch, /main\.js/);
  assert.match(diff.patch, /new\.js/);
  finish({ sessionId: 'session-1' });
  await waitForImmediate();
  store.close();
});
