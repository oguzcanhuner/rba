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
  ArtifactsRepository,
  TasksRepository,
  MAX_ARTIFACT_HTML_LENGTH,
} = require('../findings-mcp-server');
const { GoalStore } = require('../goal-store');

function goal(id) {
  return {
    id,
    title: 'Plan a change',
    workingDirectory: '/workspace',
    agentSession: null,
    messages: [],
    createdAt: '2026-08-09T10:00:00.000Z',
    updatedAt: '2026-08-09T10:00:00.000Z',
  };
}

test('artifact repository keeps multiple flat artifacts isolated by goal', (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'rba-artifacts-test-'));
  const filename = path.join(directory, 'goals.sqlite3');
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  const store = new GoalStore(filename);
  store.save(goal('goal-1'));
  store.save(goal('goal-2'));
  const repository = new ArtifactsRepository(filename, 'goal-1');
  const diagram = repository.create({
    title: 'System diagram',
    html: '<h1>System</h1>',
  });
  const prototype = repository.create({
    title: 'Prototype',
    html: '<button>Try it</button>',
  });

  assert.equal(repository.list().length, 2);
  assert.deepEqual(store.get('goal-2').artifacts, []);
  assert.equal(
    repository.update(diagram.id, { html: '<h1>Updated system</h1>' }).title,
    'System diagram',
  );
  assert.equal(repository.remove(prototype.id), true);
  assert.deepEqual(
    repository.list().map(({ title }) => title),
    ['System diagram'],
  );
  assert.throws(
    () =>
      repository.create({
        title: 'Too large',
        html: 'x'.repeat(MAX_ARTIFACT_HTML_LENGTH + 1),
      }),
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
  store.save(goal('goal-1'));
  store.save(goal('goal-2'));
  const repository = new TasksRepository(filename, 'goal-1');
  const first = repository.add({
    title: 'Persist tasks',
    specMarkdown: 'Persist them.',
  });
  const second = repository.add({
    title: 'Render tasks',
    specMarkdown: 'Render them.',
  });

  assert.equal(first.sequence, 1);
  assert.equal(second.sequence, 2);
  assert.deepEqual(store.get('goal-2').tasks, []);
  assert.equal(
    repository.update(first.id, { title: 'Persist durable tasks' }).id,
    first.id,
  );
  assert.equal(repository.remove(second.id), true);
  assert.equal(repository.commit(), 1);
  assert.equal(repository.list()[0].status, 'queued');
  repository.close();
  store.close();
});

test('serves artifact and task tools over MCP stdio', async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'rba-planner-mcp-test-'));
  const filename = path.join(directory, 'goals.sqlite3');
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  const store = new GoalStore(filename);
  store.save(goal('goal-1'));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(__dirname, '..', 'findings-mcp-server.js')],
    env: { RBA_GOAL_DATABASE: filename, RBA_GOAL_ID: 'goal-1' },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'rba-test', version: '1.0.0' });
  await client.connect(transport);
  t.after(async () => {
    await client.close();
    store.close();
  });

  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map(({ name }) => name).sort(), [
    'add_task',
    'commit_tasks',
    'create_artifact',
    'get_workflow',
    'list_artifacts',
    'list_workflows',
    'read_tasks',
    'register_workflow',
    'remove_artifact',
    'remove_task',
    'remove_workflow',
    'update_artifact',
    'update_task',
    'update_workflow',
    'validate_workflow',
  ]);
  assert.equal(
    (await client.callTool({ name: 'list_artifacts' })).content[0].text,
    '(there are no artifacts)',
  );
  await client.callTool({
    name: 'create_artifact',
    arguments: { title: 'Prototype', html: '<button>Go</button>' },
  });
  const artifact = store.get('goal-1').artifacts[0];
  assert.equal(artifact.title, 'Prototype');
  await client.callTool({
    name: 'update_artifact',
    arguments: { id: artifact.id, title: 'Interactive prototype' },
  });
  assert.equal(store.get('goal-1').artifacts[0].title, 'Interactive prototype');
  await client.callTool({
    name: 'remove_artifact',
    arguments: { id: artifact.id },
  });
  assert.deepEqual(store.get('goal-1').artifacts, []);
  await client.callTool({
    name: 'add_task',
    arguments: {
      title: 'Persist tasks',
      specMarkdown: 'Persist task records.',
    },
  });
  assert.equal(store.get('goal-1').tasks[0].status, 'draft');
});

function workflowDefinition() {
  return {
    start: 'build',
    steps: {
      build: { run: 'npm run build', onPass: 'done', onFail: 'done' },
      done: { type: 'terminal' },
    },
  };
}

test('register_workflow then get_workflow round-trips a definition', async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'rba-workflow-mcp-test-'));
  const filename = path.join(directory, 'goals.sqlite3');
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  const store = new GoalStore(filename);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(__dirname, '..', 'findings-mcp-server.js')],
    env: { RBA_GOAL_DATABASE: filename, RBA_GOAL_ID: 'goal-1' },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'rba-test', version: '1.0.0' });
  await client.connect(transport);
  t.after(async () => {
    await client.close();
    store.close();
  });

  const registerResult = await client.callTool({
    name: 'register_workflow',
    arguments: { name: 'ship-task', definition: workflowDefinition() },
  });
  assert.equal(registerResult.isError, undefined);
  assert.match(
    registerResult.content[0].text,
    /Registered ship-task \(2 steps\)/,
  );
  assert.match(registerResult.content[0].text, /Terminal step: done/);

  const getResult = await client.callTool({
    name: 'get_workflow',
    arguments: { name: 'ship-task' },
  });
  const workflow = JSON.parse(getResult.content[0].text);
  assert.deepEqual(workflow.definition, workflowDefinition());

  const listResult = await client.callTool({ name: 'list_workflows' });
  const list = JSON.parse(listResult.content[0].text);
  assert.equal(list.length, 1);
  assert.equal(list[0].stepCount, 2);
});

test('register_workflow rejects an invalid definition and stores nothing', async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'rba-workflow-mcp-test-'));
  const filename = path.join(directory, 'goals.sqlite3');
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  const store = new GoalStore(filename);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(__dirname, '..', 'findings-mcp-server.js')],
    env: { RBA_GOAL_DATABASE: filename, RBA_GOAL_ID: 'goal-1' },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'rba-test', version: '1.0.0' });
  await client.connect(transport);
  t.after(async () => {
    await client.close();
    store.close();
  });

  const badDefinition = {
    start: 'build',
    steps: { build: { run: 'npm run build', onFail: 'fixx' } },
  };
  const result = await client.callTool({
    name: 'register_workflow',
    arguments: { name: 'ship-task', definition: badDefinition },
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /fixx/);

  const listResult = await client.callTool({ name: 'list_workflows' });
  assert.equal(listResult.content[0].text, '(there are no workflows yet)');
});

test('register_workflow rejects duplicate names', async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'rba-workflow-mcp-test-'));
  const filename = path.join(directory, 'goals.sqlite3');
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  const store = new GoalStore(filename);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(__dirname, '..', 'findings-mcp-server.js')],
    env: { RBA_GOAL_DATABASE: filename, RBA_GOAL_ID: 'goal-1' },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'rba-test', version: '1.0.0' });
  await client.connect(transport);
  t.after(async () => {
    await client.close();
    store.close();
  });

  await client.callTool({
    name: 'register_workflow',
    arguments: { name: 'ship-task', definition: workflowDefinition() },
  });
  const result = await client.callTool({
    name: 'register_workflow',
    arguments: { name: 'ship-task', definition: workflowDefinition() },
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /update_workflow/);
});

test('update_workflow revalidates the definition', async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'rba-workflow-mcp-test-'));
  const filename = path.join(directory, 'goals.sqlite3');
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  const store = new GoalStore(filename);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(__dirname, '..', 'findings-mcp-server.js')],
    env: { RBA_GOAL_DATABASE: filename, RBA_GOAL_ID: 'goal-1' },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'rba-test', version: '1.0.0' });
  await client.connect(transport);
  t.after(async () => {
    await client.close();
    store.close();
  });

  await client.callTool({
    name: 'register_workflow',
    arguments: { name: 'ship-task', definition: workflowDefinition() },
  });

  const badUpdate = await client.callTool({
    name: 'update_workflow',
    arguments: {
      name: 'ship-task',
      definition: {
        start: 'build',
        steps: { build: { run: 'npm run build', onFail: 'fixx' } },
      },
    },
  });
  assert.equal(badUpdate.isError, true);
  assert.match(badUpdate.content[0].text, /fixx/);

  const goodUpdate = await client.callTool({
    name: 'update_workflow',
    arguments: { name: 'ship-task', description: 'Ships a task.' },
  });
  assert.equal(goodUpdate.isError, undefined);
  const workflow = JSON.parse(
    (
      await client.callTool({
        name: 'get_workflow',
        arguments: { name: 'ship-task' },
      })
    ).content[0].text,
  );
  assert.equal(workflow.description, 'Ships a task.');
  assert.deepEqual(workflow.definition, workflowDefinition());
});

test('validate_workflow stores nothing', async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'rba-workflow-mcp-test-'));
  const filename = path.join(directory, 'goals.sqlite3');
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  const store = new GoalStore(filename);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(__dirname, '..', 'findings-mcp-server.js')],
    env: { RBA_GOAL_DATABASE: filename, RBA_GOAL_ID: 'goal-1' },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'rba-test', version: '1.0.0' });
  await client.connect(transport);
  t.after(async () => {
    await client.close();
    store.close();
  });

  const result = await client.callTool({
    name: 'validate_workflow',
    arguments: { definition: workflowDefinition() },
  });
  assert.equal(result.isError, undefined);

  const listResult = await client.callTool({ name: 'list_workflows' });
  assert.equal(listResult.content[0].text, '(there are no workflows yet)');
});
