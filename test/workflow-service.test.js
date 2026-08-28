const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { setImmediate: waitForImmediate } = require('node:timers/promises');
const { test } = require('node:test');
const { GoalStore } = require('../goal-store');
const { WorkflowService } = require('../workflow-service');

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = 4242;
  child.killed = false;
  child.kill = () => {
    child.killed = true;
  };
  return child;
}

/** Builds an injectable spawnProcess that hands back scripted fake children
 * in call order, so tests never touch a real shell. */
function scriptedSpawn(scripts) {
  let call = 0;
  const children = [];
  const spawnProcess = (command, args, options) => {
    const script = scripts[call];
    call += 1;
    const child = fakeChild();
    children.push({ child, command, args, options });
    if (script.immediate !== false) {
      queueMicrotask(() => {
        if (script.stdout)
          child.stdout.emit('data', Buffer.from(script.stdout));
        if (script.stderr)
          child.stderr.emit('data', Buffer.from(script.stderr));
        child.emit('close', script.exitCode ?? 0);
      });
    }
    return child;
  };
  return { spawnProcess, children };
}

let directory;

function tempDirectory() {
  directory = mkdtempSync(path.join(tmpdir(), 'rba-workflow-test-'));
  return directory;
}

function storeWithWorkflow(definition, overrides = {}) {
  const store = new GoalStore(':memory:');
  const workflow = store.createWorkflow({
    name: 'ship-task',
    definition,
    directory: tempDirectory(),
    ...overrides,
  });
  return { store, workflow };
}

function linearDefinition() {
  return {
    start: 'build',
    steps: {
      build: { run: 'npm run build', next: 'done' },
      done: { type: 'terminal' },
    },
  };
}

function branchingDefinition() {
  return {
    start: 'build',
    steps: {
      build: { run: 'npm run build', onPass: 'done', onFail: 'fix' },
      fix: { run: 'npm run fix', next: 'done' },
      done: { type: 'terminal' },
    },
  };
}

test('a linear run completes', async () => {
  const { store, workflow } = storeWithWorkflow(linearDefinition());
  const { spawnProcess } = scriptedSpawn([{ exitCode: 0 }]);
  const updates = [];
  const service = new WorkflowService({
    store,
    spawnProcess,
    onUpdate: (run) => updates.push(run),
  });

  await service.start(workflow.id);
  await waitForImmediate();
  await waitForImmediate();
  await waitForImmediate();

  const run = updates.at(-1);
  assert.equal(run.status, 'completed');
  assert.equal(run.steps.length, 1);
  assert.equal(run.steps[0].status, 'pass');
  store.close();
  rmSync(directory, { force: true, recursive: true });
});

test('a non-zero exit routes down on_fail', async () => {
  const { store, workflow } = storeWithWorkflow(branchingDefinition());
  const { spawnProcess } = scriptedSpawn([{ exitCode: 1 }, { exitCode: 0 }]);
  const updates = [];
  const service = new WorkflowService({
    store,
    spawnProcess,
    onUpdate: (run) => updates.push(run),
  });

  await service.start(workflow.id);
  await waitForImmediate();
  await waitForImmediate();
  await waitForImmediate();
  await waitForImmediate();
  await waitForImmediate();

  const run = updates.at(-1);
  assert.equal(run.status, 'completed');
  assert.deepEqual(
    run.steps.map((s) => s.step),
    ['build', 'fix'],
  );
  assert.equal(run.steps[0].status, 'fail');
  store.close();
  rmSync(directory, { force: true, recursive: true });
});

test("a JSON step's summary and data persist", async () => {
  const definition = {
    start: 'review',
    steps: {
      review: {
        run: 'claude -p "review"',
        parse: 'json',
        next: 'done',
      },
      done: { type: 'terminal' },
    },
  };
  const { store, workflow } = storeWithWorkflow(definition);
  const { spawnProcess } = scriptedSpawn([
    {
      stdout: JSON.stringify({
        status: 'pass',
        summary: 'Looks good',
        data: { score: 9 },
      }),
    },
  ]);
  const updates = [];
  const service = new WorkflowService({
    store,
    spawnProcess,
    onUpdate: (run) => updates.push(run),
  });

  await service.start(workflow.id);
  await waitForImmediate();
  await waitForImmediate();
  await waitForImmediate();

  const run = updates.at(-1);
  assert.equal(run.status, 'completed');
  assert.equal(run.steps[0].summary, 'Looks good');
  assert.deepEqual(run.steps[0].data, { score: 9 });
  store.close();
  rmSync(directory, { force: true, recursive: true });
});

test('malformed JSON halts as an engine error and does not route to on_fail', async () => {
  const definition = {
    start: 'review',
    steps: {
      review: {
        run: 'claude -p "review"',
        parse: 'json',
        onPass: 'done',
        onFail: 'done',
      },
      done: { type: 'terminal' },
    },
  };
  const { store, workflow } = storeWithWorkflow(definition);
  const { spawnProcess } = scriptedSpawn([{ stdout: 'not json' }]);
  const updates = [];
  const service = new WorkflowService({
    store,
    spawnProcess,
    onUpdate: (run) => updates.push(run),
  });

  await service.start(workflow.id);
  await waitForImmediate();
  await waitForImmediate();
  await waitForImmediate();

  const run = updates.at(-1);
  assert.equal(run.status, 'failed');
  assert.ok(run.error);
  assert.equal(run.steps.length, 1);
  assert.equal(run.steps[0].status, 'error');
  store.close();
  rmSync(directory, { force: true, recursive: true });
});

test('maxVisits stops a loop', async () => {
  const definition = {
    start: 'build',
    steps: {
      build: {
        run: 'npm run build',
        onFail: 'build',
        onPass: 'done',
        maxVisits: 2,
      },
      done: { type: 'terminal' },
    },
  };
  const { store, workflow } = storeWithWorkflow(definition);
  const { spawnProcess } = scriptedSpawn([
    { exitCode: 1 },
    { exitCode: 1 },
    { exitCode: 1 },
  ]);
  const updates = [];
  const service = new WorkflowService({
    store,
    spawnProcess,
    onUpdate: (run) => updates.push(run),
  });

  await service.start(workflow.id);
  for (let i = 0; i < 6; i += 1) {
    await waitForImmediate();
  }

  const run = updates.at(-1);
  assert.equal(run.status, 'failed');
  assert.ok(run.error.includes('visit limit'));
  assert.equal(run.steps.length, 2);
  store.close();
  rmSync(directory, { force: true, recursive: true });
});

test('resume continues from current_step while fresh starts a new run', async () => {
  const { store, workflow } = storeWithWorkflow(linearDefinition());
  store.createWorkflowRun(workflow.id, {
    directory,
    currentStep: 'build',
    startedAt: '2026-08-09T10:00:00.000Z',
  });

  const { spawnProcess } = scriptedSpawn([{ exitCode: 0 }, { exitCode: 0 }]);
  const updates = [];
  const service = new WorkflowService({
    store,
    spawnProcess,
    onUpdate: (run) => updates.push(run),
  });

  const resumed = await service.start(workflow.id);
  const originalRun = store.listWorkflowRuns(workflow.id).at(-1);
  assert.equal(resumed.id, originalRun.id);
  await waitForImmediate();
  await waitForImmediate();
  await waitForImmediate();

  const fresh = await service.start(workflow.id, { fresh: true });
  assert.notEqual(fresh.id, originalRun.id);
  await waitForImmediate();
  await waitForImmediate();
  await waitForImmediate();

  assert.equal(store.listWorkflowRuns(workflow.id).length, 2);
  store.close();
  rmSync(directory, { force: true, recursive: true });
});

test('stop leaves the run resumable', async () => {
  const { store, workflow } = storeWithWorkflow(linearDefinition());
  const { spawnProcess } = scriptedSpawn([{ immediate: false }]);
  const updates = [];
  const service = new WorkflowService({
    store,
    spawnProcess,
    onUpdate: (run) => updates.push(run),
  });

  const run = await service.start(workflow.id);
  await waitForImmediate();

  const stopped = service.stop(run.id);
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.currentStep, 'build');
  store.close();
  rmSync(directory, { force: true, recursive: true });
});

test('a timeout kills and records an engine error', async () => {
  const definition = {
    start: 'build',
    steps: {
      build: { run: 'sleep 100', next: 'done', timeoutMs: 20 },
      done: { type: 'terminal' },
    },
  };
  const { store, workflow } = storeWithWorkflow(definition);
  const { spawnProcess } = scriptedSpawn([{ immediate: false }]);
  const updates = [];
  const service = new WorkflowService({
    store,
    spawnProcess,
    onUpdate: (run) => updates.push(run),
  });

  await service.start(workflow.id);
  await new Promise((resolve) => setTimeout(resolve, 60));

  const run = updates.at(-1);
  assert.equal(run.status, 'failed');
  assert.ok(run.error.includes('timed out'));
  store.close();
  rmSync(directory, { force: true, recursive: true });
});

test('env vars from earlier steps reach later ones', async () => {
  const definition = {
    start: 'first',
    steps: {
      first: { run: 'echo first', next: 'second' },
      second: { run: 'echo second', next: 'done' },
      done: { type: 'terminal' },
    },
  };
  const { store, workflow } = storeWithWorkflow(definition);
  const { spawnProcess, children } = scriptedSpawn([
    { exitCode: 0 },
    { exitCode: 0 },
  ]);
  const updates = [];
  const service = new WorkflowService({
    store,
    spawnProcess,
    onUpdate: (run) => updates.push(run),
  });

  await service.start(workflow.id);
  await waitForImmediate();
  await waitForImmediate();
  await waitForImmediate();
  await waitForImmediate();
  await waitForImmediate();

  assert.equal(children[1].options.env.RBA_STEP_FIRST_STATUS, 'pass');
  assert.equal(children[1].options.env.RBA_LAST_STATUS, 'pass');
  assert.equal(children[1].options.env.RBA_STEP, 'second');
  store.close();
  rmSync(directory, { force: true, recursive: true });
});
