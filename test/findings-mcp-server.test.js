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
  WorkStateReader,
  MAX_ARTIFACT_HTML_LENGTH,
} = require('../findings-mcp-server');
const { GoalStore } = require('../goal-store');

function makeCommandError(code) {
  const error = new Error(`git exited with code ${code}`);
  error.code = code;
  return error;
}

function seedTaskWithRun(store, { id, sequence, status, runStatus, branch }) {
  store.database
    .prepare(`
      INSERT INTO tasks (
        id, goal_id, sequence, title, spec_markdown, status,
        created_at, updated_at
      ) VALUES (?, 'goal-1', ?, ?, 'Do it.', 'queued', ?, ?)
    `)
    .run(
      id,
      sequence,
      `Task ${sequence}`,
      '2026-08-09T10:00:00.000Z',
      '2026-08-09T10:00:00.000Z',
    );
  if (runStatus) {
    store.createWorkerRun(id, {
      branch,
      worktree: `/worktrees/${id}`,
      baseRevision: 'abc123',
      startedAt: '2026-08-09T10:01:00.000Z',
    });
    if (runStatus !== 'working') {
      store.updateWorkerRun(id, { status: runStatus });
    }
  }
  if (status && status !== runStatus) {
    store.database
      .prepare('UPDATE tasks SET status = ? WHERE id = ?')
      .run(status, id);
  }
}

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

test('read_work_state reports git branch state via an injected runner', async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'rba-workstate-test-'));
  const filename = path.join(directory, 'goals.sqlite3');
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  const store = new GoalStore(filename);
  store.save(goal('goal-1'));

  seedTaskWithRun(store, {
    id: 'task-merged',
    sequence: 1,
    status: 'merged',
    runStatus: 'completed',
    branch: 'rba/merged',
  });
  seedTaskWithRun(store, {
    id: 'task-unmerged',
    sequence: 2,
    status: 'completed',
    runStatus: 'completed',
    branch: 'rba/unmerged',
  });
  seedTaskWithRun(store, {
    id: 'task-gone',
    sequence: 3,
    status: 'failed',
    runStatus: 'failed',
    branch: 'rba/gone',
  });
  seedTaskWithRun(store, {
    id: 'task-error',
    sequence: 4,
    status: 'completed',
    runStatus: 'completed',
    branch: 'rba/error',
  });
  seedTaskWithRun(store, {
    id: 'task-queued',
    sequence: 5,
    status: 'queued',
    runStatus: null,
    branch: null,
  });

  let revParseHeadCalls = 0;
  const runCommand = async (command, args) => {
    assert.equal(command, 'git');
    const subcommand = args[2];
    if (subcommand === 'rev-parse' && args.includes('HEAD')) {
      revParseHeadCalls += 1;
      return { stdout: 'base-tip-sha\n' };
    }
    if (subcommand === 'rev-parse' && args.includes('--verify')) {
      const branch = args.at(-1).replace('refs/heads/', '');
      if (branch === 'rba/gone') {
        throw makeCommandError(1);
      }
      return { stdout: '' };
    }
    if (subcommand === 'merge-base' && args.includes('--is-ancestor')) {
      const branch = args.at(-2);
      if (branch === 'rba/merged') {
        return { stdout: '' };
      }
      if (branch === 'rba/unmerged') {
        throw makeCommandError(1);
      }
      if (branch === 'rba/error') {
        throw makeCommandError(128);
      }
      throw makeCommandError(1);
    }
    if (subcommand === 'rev-list' && args.includes('--count')) {
      return { stdout: '2\n' };
    }
    if (subcommand === 'merge-base') {
      return { stdout: 'merge-base-sha\n' };
    }
    if (subcommand === 'diff') {
      return { stdout: 'a.txt\nb.txt\n' };
    }
    throw new Error(`Unexpected git invocation: ${args.join(' ')}`);
  };

  const reader = new WorkStateReader(filename, 'goal-1', { runCommand });
  t.after(() => {
    reader.close();
    store.close();
  });

  const entries = await reader.read();
  assert.equal(revParseHeadCalls, 1);

  const bySequence = Object.fromEntries(
    entries.map((entry) => [entry.sequence, entry]),
  );

  assert.equal(bySequence[1].git.mergedIntoBase, true);
  assert.equal(bySequence[1].git.branchExists, true);
  assert.equal(bySequence[1].attention, null);

  assert.equal(bySequence[2].git.mergedIntoBase, false);
  assert.equal(bySequence[2].attention, null);

  assert.equal(bySequence[3].git.branchExists, false);
  assert.equal(bySequence[3].git.mergedIntoBase, null);
  assert.equal(bySequence[3].git.commitsAhead, null);
  assert.equal(bySequence[3].git.filesChanged, null);
  assert.equal(bySequence[3].git.error, null);
  assert.equal(bySequence[3].attention, 'the worker run failed or was stopped');

  assert.equal(bySequence[4].git.mergedIntoBase, null);
  assert.equal(typeof bySequence[4].git.error, 'string');
  assert.equal(bySequence[4].git.commitsAhead, null);

  assert.equal(bySequence[5].run, null);
  assert.equal(bySequence[5].git, null);
  assert.equal(bySequence[5].startable, true);
  assert.equal(bySequence[1].startable, false);
});

test('read_work_state flags a task marked merged whose branch is not an ancestor', async (t) => {
  const directory = mkdtempSync(
    path.join(tmpdir(), 'rba-workstate-attention-'),
  );
  const filename = path.join(directory, 'goals.sqlite3');
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  const store = new GoalStore(filename);
  store.save(goal('goal-1'));
  seedTaskWithRun(store, {
    id: 'task-merged-diverged',
    sequence: 1,
    status: 'merged',
    runStatus: 'completed',
    branch: 'rba/diverged',
  });

  const runCommand = async (_command, args) => {
    const subcommand = args[2];
    if (subcommand === 'rev-parse' && args.includes('HEAD')) {
      return { stdout: 'base-tip-sha\n' };
    }
    if (subcommand === 'rev-parse' && args.includes('--verify')) {
      return { stdout: '' };
    }
    if (subcommand === 'merge-base' && args.includes('--is-ancestor')) {
      throw makeCommandError(1);
    }
    if (subcommand === 'rev-list') {
      return { stdout: '3\n' };
    }
    if (subcommand === 'merge-base') {
      return { stdout: 'merge-base-sha\n' };
    }
    if (subcommand === 'diff') {
      return { stdout: '' };
    }
    throw new Error(`Unexpected git invocation: ${args.join(' ')}`);
  };

  const reader = new WorkStateReader(filename, 'goal-1', { runCommand });
  t.after(() => {
    reader.close();
    store.close();
  });
  const [entry] = await reader.read();
  assert.equal(
    entry.attention,
    "the task is marked merged but its branch isn't an ancestor of the base",
  );
});

test('read_work_state flags a run that finished while the task is still working', async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'rba-workstate-stuck-'));
  const filename = path.join(directory, 'goals.sqlite3');
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  const store = new GoalStore(filename);
  store.save(goal('goal-1'));
  store.database
    .prepare(`
      INSERT INTO tasks (
        id, goal_id, sequence, title, spec_markdown, status,
        created_at, updated_at
      ) VALUES ('task-1', 'goal-1', 1, 'Stuck task', 'Do it.', 'queued',
        '2026-08-09T10:00:00.000Z', '2026-08-09T10:00:00.000Z')
    `)
    .run();
  store.createWorkerRun('task-1', {
    branch: 'rba/task-1',
    worktree: '/worktrees/task-1',
    baseRevision: 'abc123',
    startedAt: '2026-08-09T10:01:00.000Z',
  });
  store.updateWorkerRun('task-1', { status: 'completed' });
  store.database
    .prepare("UPDATE tasks SET status = 'working' WHERE id = 'task-1'")
    .run();

  const runCommand = async (_command, args) => {
    const subcommand = args[2];
    if (subcommand === 'rev-parse' && args.includes('HEAD')) {
      return { stdout: 'base-tip-sha\n' };
    }
    if (subcommand === 'rev-parse' && args.includes('--verify')) {
      return { stdout: '' };
    }
    if (subcommand === 'merge-base' && args.includes('--is-ancestor')) {
      throw makeCommandError(1);
    }
    if (subcommand === 'rev-list') {
      return { stdout: '0\n' };
    }
    if (subcommand === 'merge-base') {
      return { stdout: 'merge-base-sha\n' };
    }
    if (subcommand === 'diff') {
      return { stdout: '' };
    }
    throw new Error(`Unexpected git invocation: ${args.join(' ')}`);
  };

  const reader = new WorkStateReader(filename, 'goal-1', { runCommand });
  t.after(() => {
    reader.close();
    store.close();
  });
  const [entry] = await reader.read();
  assert.equal(
    entry.attention,
    'the worker run finished but the task is still marked working',
  );
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
    'read_work_state',
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
