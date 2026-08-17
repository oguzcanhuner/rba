const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const {
  StdioClientTransport,
} = require('@modelcontextprotocol/sdk/client/stdio.js');
const {
  FindingsRepository,
  TasksRepository,
  MAX_FINDINGS_LENGTH,
} = require('../findings-mcp-server');
const { GoalStore } = require('../goal-store');

test('findings tools read and update only their goal in SQLite', (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'rba-findings-test-'));
  const filename = path.join(directory, 'goals.sqlite3');
  t.after(() => rmSync(directory, { force: true, recursive: true }));

  const store = new GoalStore(filename);
  const base = {
    title: 'Record findings',
    workingDirectory: '/workspace',
    agentSession: null,
    findingsMarkdown: null,
    messages: [],
    createdAt: '2026-08-09T10:00:00.000Z',
    updatedAt: '2026-08-09T10:00:00.000Z',
  };
  store.save({ ...base, id: 'goal-1' });
  store.save({ ...base, id: 'goal-2' });

  const repository = new FindingsRepository(filename, 'goal-1');
  assert.equal(repository.read(), null);
  assert.equal(repository.update('# Findings\n\nA decision.'), true);
  assert.equal(repository.read(), '# Findings\n\nA decision.');
  assert.equal(store.get('goal-2').findingsMarkdown, null);
  assert.throws(
    () => repository.update('x'.repeat(MAX_FINDINGS_LENGTH + 1)),
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

test('serves read_findings and update_findings over MCP stdio', async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'rba-findings-mcp-test-'));
  const filename = path.join(directory, 'goals.sqlite3');
  t.after(() => rmSync(directory, { force: true, recursive: true }));

  const store = new GoalStore(filename);
  store.save({
    id: 'goal-1',
    title: 'Record findings',
    workingDirectory: '/workspace',
    agentSession: null,
    findingsMarkdown: null,
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
    'add_task',
    'commit_tasks',
    'read_findings',
    'read_tasks',
    'remove_task',
    'update_findings',
    'update_task',
  ]);
  assert.equal(
    tools.tools.find((tool) => tool.name === 'update_findings')?.annotations
      ?.destructiveHint,
    true,
  );

  const empty = await client.callTool({ name: 'read_findings' });
  assert.equal(empty.content[0].text, '(the findings document is empty)');

  const updated = await client.callTool({
    name: 'update_findings',
    arguments: { markdown: '# Findings\n\nUpdated through MCP.' },
  });
  assert.equal(updated.isError, undefined);
  assert.equal(
    store.get('goal-1').findingsMarkdown,
    '# Findings\n\nUpdated through MCP.',
  );

  const added = await client.callTool({
    name: 'add_task',
    arguments: {
      title: 'Persist tasks',
      specMarkdown: '## Goal\n\nPersist task records.',
    },
  });
  assert.equal(added.isError, undefined);

  const tasks = store.get('goal-1').tasks;
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].status, 'draft');

  const read = await client.callTool({ name: 'read_tasks' });
  assert.match(read.content[0].text, /Persist tasks/);

  const taskId = tasks[0].id;
  await client.callTool({
    name: 'update_task',
    arguments: { id: taskId, title: 'Persist durable tasks' },
  });
  await client.callTool({ name: 'commit_tasks' });
  assert.equal(store.get('goal-1').tasks[0].status, 'queued');

  await client.callTool({ name: 'remove_task', arguments: { id: taskId } });
  assert.deepEqual(store.get('goal-1').tasks, []);
});
