const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');
const { GoalStore } = require('../goal-store');

function goal(overrides = {}) {
  return {
    id: 'goal-1',
    title: 'Plan persistent conversations',
    workingDirectory: '/workspace',
    agentSession: null,
    artifacts: [],
    tasks: [],
    messages: [
      {
        id: 'message-1',
        role: 'user',
        status: 'complete',
        parts: [{ type: 'text', id: 'part-1', text: 'Hello' }],
      },
    ],
    createdAt: '2026-08-09T10:00:00.000Z',
    updatedAt: '2026-08-09T10:00:00.000Z',
    ...overrides,
  };
}

test('persists and lists goals', () => {
  const store = new GoalStore(':memory:');
  const saved = goal();
  const newer = goal({
    id: 'goal-2',
    title: 'A newer goal',
    messages: [],
    createdAt: '2026-08-09T11:00:00.000Z',
    updatedAt: '2026-08-09T11:00:00.000Z',
  });

  store.save(saved);
  store.save(newer);
  const continued = {
    ...saved,
    updatedAt: '2026-08-09T12:00:00.000Z',
  };
  store.save(continued);

  assert.deepEqual(store.list(), [
    {
      id: newer.id,
      title: newer.title,
      workingDirectory: newer.workingDirectory,
      createdAt: newer.createdAt,
      updatedAt: newer.updatedAt,
      unread: false,
      completed: false,
    },
    {
      id: saved.id,
      title: saved.title,
      workingDirectory: saved.workingDirectory,
      createdAt: saved.createdAt,
      updatedAt: continued.updatedAt,
      unread: false,
      completed: false,
    },
  ]);
  assert.deepEqual(store.get(saved.id), {
    ...continued,
    unread: false,
    completed: false,
  });
  store.close();
});

test('marks a goal unread and read', () => {
  const store = new GoalStore(':memory:');
  const saved = goal();
  store.save(saved);

  assert.equal(store.get(saved.id).unread, false);

  store.markUnread(saved.id);
  assert.equal(store.get(saved.id).unread, true);
  assert.equal(store.list().find((item) => item.id === saved.id).unread, true);

  store.markRead(saved.id);
  assert.equal(store.get(saved.id).unread, false);
  assert.equal(store.list().find((item) => item.id === saved.id).unread, false);

  store.close();
});

test('renames, completes, and reopens a goal', () => {
  const store = new GoalStore(':memory:');
  const saved = goal();
  store.save(saved);

  store.renameGoal(saved.id, 'A better title');
  assert.equal(store.get(saved.id).title, 'A better title');

  store.completeGoal(saved.id);
  assert.equal(store.get(saved.id).completed, true);
  assert.equal(
    store.list().find((item) => item.id === saved.id).completed,
    true,
  );

  store.reopenGoal(saved.id);
  assert.equal(store.get(saved.id).completed, false);

  assert.throws(() => store.renameGoal('missing', 'x'));
  store.close();
});

test('sorts completed goals after active ones', () => {
  const store = new GoalStore(':memory:');
  const older = goal({
    id: 'goal-older',
    createdAt: '2026-08-09T09:00:00.000Z',
    updatedAt: '2026-08-09T09:00:00.000Z',
  });
  const newer = goal({
    id: 'goal-newer',
    createdAt: '2026-08-09T10:00:00.000Z',
    updatedAt: '2026-08-09T10:00:00.000Z',
  });
  store.save(older);
  store.save(newer);
  store.completeGoal(newer.id);

  assert.deepEqual(
    store.list().map((item) => item.id),
    [older.id, newer.id],
  );
  store.close();
});

test('deletes a goal only when it has no started tasks', () => {
  const store = new GoalStore(':memory:');
  const saved = goal();
  store.save(saved);
  store.database
    .prepare(`
      INSERT INTO tasks (
        id, goal_id, sequence, title, spec_markdown, status,
        created_at, updated_at
      ) VALUES (?, ?, 1, ?, ?, 'queued', ?, ?)
    `)
    .run(
      'task-1',
      saved.id,
      'A queued task',
      'Do the thing.',
      saved.createdAt,
      saved.createdAt,
    );

  store.deleteGoal(saved.id);
  assert.equal(store.get(saved.id), null);
  store.close();
});

test('deletes a goal even when it has a started task', () => {
  const store = new GoalStore(':memory:');
  const saved = goal();
  store.save(saved);
  store.database
    .prepare(`
      INSERT INTO tasks (
        id, goal_id, sequence, title, spec_markdown, status,
        created_at, updated_at
      ) VALUES (?, ?, 1, ?, ?, 'working', ?, ?)
    `)
    .run(
      'task-1',
      saved.id,
      'A working task',
      'Do the thing.',
      saved.createdAt,
      saved.createdAt,
    );

  store.deleteGoal(saved.id);
  assert.equal(store.get(saved.id), null);
  store.close();
});

test('save does not reset the unread flag', () => {
  const store = new GoalStore(':memory:');
  const saved = goal();
  store.save(saved);
  store.markUnread(saved.id);

  store.save({ ...saved, updatedAt: '2026-08-09T13:00:00.000Z' });

  assert.equal(store.get(saved.id).unread, true);
  store.close();
});

test('stores provider-neutral agent sessions and message updates', () => {
  const store = new GoalStore(':memory:');
  const initial = goal();
  const agentSession = {
    id: 'agent-session-1',
    provider: 'claude',
    externalId: 'claude-session-123',
    metadata: { model: 'sonnet' },
    createdAt: initial.createdAt,
    updatedAt: '2026-08-09T10:01:00.000Z',
  };
  const updated = goal({
    agentSession,
    messages: [
      ...initial.messages,
      {
        id: 'message-2',
        role: 'assistant',
        status: 'complete',
        parts: [{ type: 'text', id: 'part-2', text: 'Hi' }],
      },
    ],
    updatedAt: agentSession.updatedAt,
  });

  store.save(initial);
  store.save(updated);

  assert.deepEqual(store.get(initial.id), {
    ...updated,
    unread: false,
    completed: false,
  });

  const codexSession = {
    ...agentSession,
    id: 'agent-session-2',
    provider: 'codex',
    externalId: 'codex-session-456',
    metadata: { rolloutPath: '/sessions/456.jsonl' },
  };
  const switchedProvider = { ...updated, agentSession: codexSession };
  store.save(switchedProvider);

  assert.deepEqual(store.get(initial.id), {
    ...switchedProvider,
    unread: false,
    completed: false,
  });
  store.close();
});

test('lists tasks with stable sequence order and commits drafts', () => {
  const store = new GoalStore(':memory:');
  store.save(goal());
  store.database
    .prepare(`
      INSERT INTO tasks (
        id, goal_id, sequence, title, spec_markdown, status,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      'task-2',
      'goal-1',
      2,
      'Second task',
      '## Goal\n\nSecond.',
      'queued',
      '2026-08-09T10:02:00.000Z',
      '2026-08-09T10:02:00.000Z',
    );
  store.database
    .prepare(`
      INSERT INTO tasks (
        id, goal_id, sequence, title, spec_markdown, status,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      'task-1',
      'goal-1',
      1,
      'First task',
      '## Goal\n\nFirst.',
      'draft',
      '2026-08-09T10:01:00.000Z',
      '2026-08-09T10:01:00.000Z',
    );

  assert.deepEqual(
    store.get('goal-1').tasks.map(({ id, sequence, status }) => ({
      id,
      sequence,
      status,
    })),
    [
      { id: 'task-1', sequence: 1, status: 'draft' },
      { id: 'task-2', sequence: 2, status: 'queued' },
    ],
  );
  assert.deepEqual(
    store.listCommittedTasks().map(({ id }) => id),
    ['task-2'],
  );

  const committed = store.commitTasks('goal-1');
  assert.deepEqual(
    committed.map(({ id, status }) => ({ id, status })),
    [
      { id: 'task-1', status: 'queued' },
      { id: 'task-2', status: 'queued' },
    ],
  );
  assert.deepEqual(
    store.listCommittedTasks().map(({ id, goalId, goalTitle }) => ({
      id,
      goalId,
      goalTitle,
    })),
    [
      {
        id: 'task-2',
        goalId: 'goal-1',
        goalTitle: 'Plan persistent conversations',
      },
      {
        id: 'task-1',
        goalId: 'goal-1',
        goalTitle: 'Plan persistent conversations',
      },
    ],
  );
  store.close();
});

test('records each applied schema migration', () => {
  const store = new GoalStore(':memory:');

  assert.deepEqual(
    store.database
      .prepare('SELECT version FROM schema_migrations ORDER BY version')
      .all()
      .map(({ version }) => version),
    [1, 2, 3, 4, 5, 8, 9, 10, 11],
  );
  store.close();
});

test('repairs a missing findings column even when migration 2 is marked complete', (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'rba-store-test-'));
  const filename = path.join(directory, 'goals.sqlite3');
  t.after(() => rmSync(directory, { force: true, recursive: true }));

  const oldDatabase = new DatabaseSync(filename);
  oldDatabase.exec(`
    CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY);
    INSERT INTO schema_migrations(version) VALUES (2);
    CREATE TABLE goals (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      working_directory TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO goals VALUES (
      'existing',
      'Existing goal',
      '/workspace',
      '2026-08-09T10:00:00.000Z',
      '2026-08-09T10:00:00.000Z'
    );
  `);
  oldDatabase.close();

  const store = new GoalStore(filename);
  assert.equal(
    store.database
      .prepare('PRAGMA table_info(goals)')
      .all()
      .some((column) => column.name === 'findings_markdown'),
    true,
  );
  assert.deepEqual(
    store.database
      .prepare('SELECT version FROM schema_migrations ORDER BY version')
      .all()
      .map(({ version }) => version),
    [1, 2, 3, 4, 5, 8, 9, 10, 11],
  );
  store.close();
});

test('persists a worker run and its conversation', () => {
  const store = new GoalStore(':memory:');
  store.save(goal());
  store.database
    .prepare(`
      INSERT INTO tasks (
        id, goal_id, sequence, title, spec_markdown, status,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)
    `)
    .run(
      'task-1',
      'goal-1',
      1,
      'Implement workers',
      'Build the worker.',
      '2026-08-09T10:01:00.000Z',
      '2026-08-09T10:01:00.000Z',
    );

  store.createWorkerRun('task-1', {
    branch: 'rba/task-1',
    worktree: '/worktrees/task-1',
    baseRevision: 'abc123',
    startedAt: '2026-08-09T10:02:00.000Z',
  });
  store.saveWorkerMessage('task-1', {
    id: 'worker-task-1',
    role: 'assistant',
    status: 'streaming',
    parts: [{ type: 'text', id: 'part-1', text: 'Working.' }],
  });
  const completed = store.updateWorkerRun('task-1', {
    status: 'completed',
    sessionId: 'session-1',
  });

  assert.equal(completed.status, 'completed');
  assert.equal(completed.sessionId, 'session-1');
  assert.equal(completed.baseRevision, 'abc123');
  assert.equal(completed.messages[0].parts[0].text, 'Working.');
  assert.equal(store.get('goal-1').tasks[0].status, 'completed');
  assert.throws(
    () =>
      store.createWorkerRun('task-1', {
        branch: 'another',
        worktree: '/another',
        startedAt: '2026-08-09T10:03:00.000Z',
      }),
    /queued/,
  );
  store.close();
});

test('marks a task as merged without touching its worker run', () => {
  const store = new GoalStore(':memory:');
  store.save(goal());
  store.database
    .prepare(`
      INSERT INTO tasks (
        id, goal_id, sequence, title, spec_markdown, status,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)
    `)
    .run(
      'task-1',
      'goal-1',
      1,
      'Implement workers',
      'Build the worker.',
      '2026-08-09T10:01:00.000Z',
      '2026-08-09T10:01:00.000Z',
    );
  store.createWorkerRun('task-1', {
    branch: 'rba/task-1',
    worktree: '/worktrees/task-1',
    baseRevision: 'abc123',
    startedAt: '2026-08-09T10:02:00.000Z',
  });
  store.updateWorkerRun('task-1', { status: 'completed' });

  store.completeTask('task-1');

  assert.equal(store.get('goal-1').tasks[0].status, 'merged');
  assert.equal(store.getWorkerRun('task-1').status, 'completed');
  assert.throws(() => store.completeTask('task-1'), /merged/);
  store.close();
});

test('deletes a working task and its worker run rows', () => {
  const store = new GoalStore(':memory:');
  store.save(goal());
  store.database
    .prepare(`
      INSERT INTO tasks (
        id, goal_id, sequence, title, spec_markdown, status,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)
    `)
    .run(
      'task-1',
      'goal-1',
      1,
      'Implement workers',
      'Build the worker.',
      '2026-08-09T10:01:00.000Z',
      '2026-08-09T10:01:00.000Z',
    );
  store.createWorkerRun('task-1', {
    branch: 'rba/task-1',
    worktree: '/worktrees/task-1',
    baseRevision: 'abc123',
    startedAt: '2026-08-09T10:02:00.000Z',
  });
  store.saveWorkerMessage('task-1', {
    id: 'worker-task-1',
    role: 'assistant',
    status: 'streaming',
    parts: [{ type: 'text', id: 'part-1', text: 'Working.' }],
  });

  store.deleteTask('task-1');

  assert.equal(
    store.database.prepare('SELECT 1 FROM tasks WHERE id = ?').get('task-1'),
    undefined,
  );
  assert.equal(
    store.database
      .prepare('SELECT 1 FROM worker_runs WHERE task_id = ?')
      .get('task-1'),
    undefined,
  );
  assert.equal(
    store.database
      .prepare('SELECT 1 FROM worker_messages WHERE task_id = ?')
      .get('task-1'),
    undefined,
  );
  store.close();
});

test('throws when deleting a missing task', () => {
  const store = new GoalStore(':memory:');
  assert.throws(() => store.deleteTask('missing'), /no longer exists/);
  store.close();
});

test('scopes listWorkerRunsForGoal to the goal', () => {
  const store = new GoalStore(':memory:');
  store.save(goal());
  store.save(goal({ id: 'goal-2' }));
  store.database
    .prepare(`
      INSERT INTO tasks (
        id, goal_id, sequence, title, spec_markdown, status,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)
    `)
    .run(
      'task-1',
      'goal-1',
      1,
      'Implement workers',
      'Build the worker.',
      '2026-08-09T10:01:00.000Z',
      '2026-08-09T10:01:00.000Z',
    );
  store.database
    .prepare(`
      INSERT INTO tasks (
        id, goal_id, sequence, title, spec_markdown, status,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)
    `)
    .run(
      'task-2',
      'goal-2',
      1,
      'Implement other',
      'Build the other.',
      '2026-08-09T10:01:00.000Z',
      '2026-08-09T10:01:00.000Z',
    );
  store.createWorkerRun('task-1', {
    branch: 'rba/task-1',
    worktree: '/worktrees/task-1',
    baseRevision: 'abc123',
    startedAt: '2026-08-09T10:02:00.000Z',
  });
  store.createWorkerRun('task-2', {
    branch: 'rba/task-2',
    worktree: '/worktrees/task-2',
    baseRevision: 'abc123',
    startedAt: '2026-08-09T10:02:00.000Z',
  });

  assert.deepEqual(store.listWorkerRunsForGoal('goal-1'), [
    { taskId: 'task-1', branch: 'rba/task-1', worktree: '/worktrees/task-1' },
  ]);
  store.close();
});

test('marks unfinished workers and tool activity as failed on restart', () => {
  const store = new GoalStore(':memory:');
  store.save(goal());
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
      'Implement workers',
      'Build the worker.',
      '2026-08-09T10:01:00.000Z',
      '2026-08-09T10:01:00.000Z',
    );
  store.createWorkerRun('task-1', {
    branch: 'rba/task-1',
    worktree: '/worktrees/task-1',
    startedAt: '2026-08-09T10:02:00.000Z',
  });
  store.saveWorkerMessage('task-1', {
    id: 'worker-task-1',
    role: 'assistant',
    status: 'streaming',
    parts: [
      {
        type: 'tool',
        tool: {
          id: 'tool-1',
          name: 'Read',
          input: null,
          status: 'running',
        },
      },
    ],
  });

  store.interruptWorkingRuns();

  const run = store.getWorkerRun('task-1');
  assert.equal(run.status, 'failed');
  assert.match(run.error, /stopped before/);
  assert.equal(run.messages[0].status, 'error');
  assert.equal(run.messages[0].parts[0].tool.status, 'error');
  store.close();
});

test('settings default to sonnet when unset', () => {
  const store = new GoalStore(':memory:');

  assert.deepEqual(store.getSettings(), {
    plannerModel: 'sonnet',
    workerModel: 'sonnet',
  });
  store.close();
});

test('settings persist updates independently', () => {
  const store = new GoalStore(':memory:');

  store.updateSettings({ plannerModel: 'opus' });
  assert.deepEqual(store.getSettings(), {
    plannerModel: 'opus',
    workerModel: 'sonnet',
  });

  store.updateSettings({ workerModel: 'haiku' });
  assert.deepEqual(store.getSettings(), {
    plannerModel: 'opus',
    workerModel: 'haiku',
  });

  store.close();
});
