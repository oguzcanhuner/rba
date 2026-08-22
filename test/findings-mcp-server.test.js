const assert = require('node:assert/strict');
const {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const {
  StdioClientTransport,
} = require('@modelcontextprotocol/sdk/client/stdio.js');
const {
  AuditRepository,
  TasksRepository,
  MAX_AUDIT_LENGTH,
} = require('../findings-mcp-server');
const { GoalStore } = require('../goal-store');

test('audit repository upserts test traces for one goal', (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'rba-findings-test-'));
  const filename = path.join(directory, 'goals.sqlite3');
  t.after(() => rmSync(directory, { force: true, recursive: true }));

  const store = new GoalStore(filename);
  const base = {
    title: 'Record findings',
    workingDirectory: directory,
    agentSession: null,
    findingsMarkdown: null,
    messages: [],
    createdAt: '2026-08-09T10:00:00.000Z',
    updatedAt: '2026-08-09T10:00:00.000Z',
  };
  store.save({ ...base, id: 'goal-1' });
  store.save({ ...base, id: 'goal-2' });

  const repository = new AuditRepository(filename, 'goal-1');
  assert.deepEqual(repository.read(), []);
  const trace = {
    framework: 'vitest',
    testPath: 'test/request.test.ts',
    testName: null,
    createdAt: '2026-08-17T10:00:00.000Z',
    success: true,
    durationMs: 12,
    assertions: [],
  };
  const firstTrace = repository.upsertTestTrace(trace);
  const refreshedTrace = repository.upsertTestTrace({
    ...trace,
    createdAt: '2026-08-17T10:01:00.000Z',
  });
  assert.equal(refreshedTrace.id, firstTrace.id);
  assert.equal(repository.read().length, 1);
  assert.equal(repository.read()[0].createdAt, '2026-08-17T10:01:00.000Z');
  assert.deepEqual(repository.readForAgent(), [
    {
      id: firstTrace.id,
      kind: 'test-trace',
      framework: 'vitest',
      testPath: 'test/request.test.ts',
      testName: null,
      createdAt: '2026-08-17T10:01:00.000Z',
      success: true,
      assertionCount: 0,
    },
  ]);
  assert.equal(repository.remove(firstTrace.id), true);
  assert.deepEqual(repository.read(), []);
  assert.deepEqual(store.get('goal-2').auditArtifacts, []);
  assert.throws(
    () =>
      repository.write([
        {
          id: 'too-large',
          kind: 'test-trace',
          testPath: 'x'.repeat(MAX_AUDIT_LENGTH + 1),
        },
      ]),
    /invalid/,
  );

  repository.close();
  store.close();
});

test('task repository isolates goals and preserves stable task identity', (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'rba-tasks-test-'));
  const filename = path.join(directory, 'goals.sqlite3');
  t.after(() => rmSync(directory, { force: true, recursive: true }));

  const store = new GoalStore(filename);
  const base = {
    title: 'Break down tasks',
    workingDirectory: '/workspace',
    agentSession: null,
    findingsMarkdown: null,
    tasks: [],
    messages: [],
    createdAt: '2026-08-09T10:00:00.000Z',
    updatedAt: '2026-08-09T10:00:00.000Z',
  };
  store.save({ ...base, id: 'goal-1' });
  store.save({ ...base, id: 'goal-2' });

  const repository = new TasksRepository(filename, 'goal-1');
  const first = repository.add({
    title: 'Persist tasks',
    specMarkdown: '## Goal\n\nPersist them.',
  });
  const second = repository.add({
    title: 'Render tasks',
    specMarkdown: '## Goal\n\nRender them.',
  });

  assert.equal(first.sequence, 1);
  assert.equal(second.sequence, 2);
  assert.notEqual(first.id, second.id);
  assert.deepEqual(store.get('goal-2').tasks, []);

  const updated = repository.update(first.id, {
    title: 'Persist durable tasks',
  });
  assert.equal(updated.id, first.id);
  assert.equal(updated.sequence, first.sequence);
  assert.equal(updated.title, 'Persist durable tasks');
  assert.equal(updated.specMarkdown, first.specMarkdown);

  assert.equal(repository.remove(second.id), true);
  assert.equal(repository.commit(), 1);
  assert.deepEqual(
    repository.list().map(({ id, status }) => ({ id, status })),
    [{ id: first.id, status: 'queued' }],
  );

  repository.close();
  store.close();

  const reopened = new GoalStore(filename);
  assert.deepEqual(
    reopened.get('goal-1').tasks.map(({ id, status }) => ({
      id,
      status,
    })),
    [{ id: first.id, status: 'queued' }],
  );
  reopened.close();
});

test('serves audit tools and a read-only plan over MCP stdio', async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'rba-findings-mcp-test-'));
  const filename = path.join(directory, 'goals.sqlite3');
  t.after(() => rmSync(directory, { force: true, recursive: true }));

  const store = new GoalStore(filename);
  mkdirSync(path.join(directory, 'test'));
  const executable = path.join(directory, 'node_modules', '.bin', 'vitest');
  mkdirSync(path.dirname(executable), { recursive: true });
  writeFileSync(
    path.join(directory, 'package.json'),
    JSON.stringify({ devDependencies: { vitest: '^2.1.0' } }),
  );
  writeFileSync(path.join(directory, 'test', 'feature.test.js'), 'test');
  const report = JSON.stringify({
    success: true,
    startTime: Date.now() - 5,
    testResults: [
      {
        assertionResults: [
          {
            fullName: 'feature works',
            status: 'passed',
            duration: 3,
            failureMessages: [],
            location: { line: 2, column: 1 },
          },
        ],
      },
    ],
  });
  writeFileSync(
    executable,
    [
      '#!/bin/sh',
      'for arg in "$@"; do',
      '  case "$arg" in',
      '    --outputFile=*) output="$' + '{arg#--outputFile=}" ;;',
      '  esac',
      'done',
      `printf '%s' '${report}' > "$output"`,
      '',
    ].join('\n'),
  );
  chmodSync(executable, 0o755);
  store.save({
    id: 'goal-1',
    title: 'Record findings',
    workingDirectory: directory,
    agentSession: null,
    findingsMarkdown: null,
    auditArtifacts: [],
    planMarkdown: '# Plan\n\nKeep ownership with the user.',
    tasks: [],
    messages: [],
    createdAt: '2026-08-09T10:00:00.000Z',
    updatedAt: '2026-08-09T10:00:00.000Z',
  });

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(__dirname, '..', 'findings-mcp-server.js')],
    env: {
      RBA_GOAL_DATABASE: filename,
      RBA_GOAL_ID: 'goal-1',
    },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'rba-test', version: '1.0.0' });
  await client.connect(transport);
  t.after(async () => {
    await client.close();
    store.close();
  });

  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
    'add_test_trace',
    'read_artifacts',
    'read_plan',
    'remove_artifact',
  ]);
  assert.equal(
    tools.tools.find((tool) => tool.name === 'add_test_trace')?.annotations
      ?.destructiveHint,
    false,
  );

  const empty = await client.callTool({ name: 'read_artifacts' });
  assert.equal(empty.content[0].text, '[]');

  const added = await client.callTool({
    name: 'add_test_trace',
    arguments: { path: 'test/feature.test.js' },
  });
  assert.equal(added.isError, undefined);
  const [storedArtifact] = store.get('goal-1').auditArtifacts;
  assert.equal(storedArtifact.kind, 'test-trace');
  assert.equal(storedArtifact.framework, 'vitest');
  assert.equal(storedArtifact.testPath, 'test/feature.test.js');
  assert.equal(storedArtifact.testName, null);
  assert.equal(storedArtifact.success, true);
  assert.deepEqual(storedArtifact.assertions, [
    {
      name: 'feature works',
      status: 'passed',
      durationMs: 3,
      location: { line: 2, column: 1 },
      failures: [],
    },
  ]);

  const listed = JSON.parse(
    (await client.callTool({ name: 'read_artifacts' })).content[0].text,
  );
  assert.deepEqual(listed, [
    {
      id: storedArtifact.id,
      kind: 'test-trace',
      framework: 'vitest',
      testPath: 'test/feature.test.js',
      testName: null,
      createdAt: storedArtifact.createdAt,
      success: true,
      assertionCount: 1,
    },
  ]);

  const removed = await client.callTool({
    name: 'remove_artifact',
    arguments: { id: storedArtifact.id },
  });
  assert.equal(removed.isError, undefined);
  assert.deepEqual(store.get('goal-1').auditArtifacts, []);

  const plan = await client.callTool({ name: 'read_plan' });
  assert.equal(plan.content[0].text, '# Plan\n\nKeep ownership with the user.');
});
