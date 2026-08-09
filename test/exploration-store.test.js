const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');
const { ExplorationStore } = require('../exploration-store');

function exploration(overrides = {}) {
  return {
    id: 'exploration-1',
    title: 'Plan persistent conversations',
    workingDirectory: '/workspace',
    agentSession: null,
    findingsMarkdown: null,
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

test('persists and lists explorations', () => {
  const store = new ExplorationStore(':memory:');
  const saved = exploration();
  const newer = exploration({
    id: 'exploration-2',
    title: 'A newer exploration',
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
    },
    {
      id: saved.id,
      title: saved.title,
      workingDirectory: saved.workingDirectory,
      createdAt: saved.createdAt,
      updatedAt: continued.updatedAt,
    },
  ]);
  assert.deepEqual(store.get(saved.id), continued);
  store.close();
});

test('stores provider-neutral agent sessions and message updates', () => {
  const store = new ExplorationStore(':memory:');
  const initial = exploration();
  const agentSession = {
    id: 'agent-session-1',
    provider: 'claude',
    externalId: 'claude-session-123',
    metadata: { model: 'sonnet' },
    createdAt: initial.createdAt,
    updatedAt: '2026-08-09T10:01:00.000Z',
  };
  const updated = exploration({
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

  assert.deepEqual(store.get(initial.id), updated);

  const codexSession = {
    ...agentSession,
    id: 'agent-session-2',
    provider: 'codex',
    externalId: 'codex-session-456',
    metadata: { rolloutPath: '/sessions/456.jsonl' },
  };
  const switchedProvider = { ...updated, agentSession: codexSession };
  store.save(switchedProvider);

  assert.deepEqual(store.get(initial.id), switchedProvider);
  store.close();
});

test('persists findings as part of an exploration', () => {
  const store = new ExplorationStore(':memory:');
  store.save(
    exploration({ findingsMarkdown: '# Findings\n\nA durable decision.' }),
  );

  assert.equal(
    store.get('exploration-1').findingsMarkdown,
    '# Findings\n\nA durable decision.',
  );
  store.close();
});

test('records each applied schema migration', () => {
  const store = new ExplorationStore(':memory:');

  assert.deepEqual(
    store.database
      .prepare('SELECT version FROM schema_migrations ORDER BY version')
      .all()
      .map(({ version }) => version),
    [1, 2],
  );
  store.close();
});

test('repairs a missing findings column even when migration 2 is marked complete', (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'rba-store-test-'));
  const filename = path.join(directory, 'explorations.sqlite3');
  t.after(() => rmSync(directory, { force: true, recursive: true }));

  const oldDatabase = new DatabaseSync(filename);
  oldDatabase.exec(`
    CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY);
    INSERT INTO schema_migrations(version) VALUES (2);
    CREATE TABLE explorations (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      working_directory TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO explorations VALUES (
      'existing',
      'Existing exploration',
      '/workspace',
      '2026-08-09T10:00:00.000Z',
      '2026-08-09T10:00:00.000Z'
    );
  `);
  oldDatabase.close();

  const store = new ExplorationStore(filename);
  assert.equal(store.get('existing').findingsMarkdown, null);
  assert.equal(
    store.database
      .prepare('PRAGMA table_info(explorations)')
      .all()
      .some((column) => column.name === 'findings_markdown'),
    true,
  );
  assert.deepEqual(
    store.database
      .prepare('SELECT version FROM schema_migrations ORDER BY version')
      .all()
      .map(({ version }) => version),
    [1, 2],
  );
  store.close();
});
