const assert = require('node:assert/strict');
const { test } = require('node:test');
const { GoalStore } = require('../goal-store');
const { WorkflowStore } = require('../workflow-store');

function stores() {
  const goals = new GoalStore(':memory:');
  goals.save({
    id: 'goal-1',
    title: 'Build workflows',
    workingDirectory: '/repo',
    agentSession: null,
    findingsMarkdown: null,
    planMarkdown: null,
    auditArtifacts: [],
    messages: [],
    createdAt: '2026-08-22T10:00:00.000Z',
    updatedAt: '2026-08-22T10:00:00.000Z',
  });
  goals.database
    .prepare(`
      INSERT INTO tasks (
        id, goal_id, sequence, title, spec_markdown, status, created_at, updated_at
      ) VALUES ('task-1', 'goal-1', 1, 'Implement it', 'Do the work', 'queued', ?, ?)
    `)
    .run('2026-08-22T10:01:00.000Z', '2026-08-22T10:01:00.000Z');
  return { goals, workflows: new WorkflowStore(goals.database) };
}

test('persists workflow snapshots and replayable operation results', () => {
  const { goals, workflows } = stores();
  const run = workflows.createRun({
    taskId: 'task-1',
    workflowName: 'verify',
    sourcePath: '/repo/.rba/workflows/verify.workflow.ts',
    sourceHash: 'abc',
    bundledSource: 'compiled source',
    input: { task: { id: 'task-1' } },
  });

  workflows.startOperation(run.id, 'tests', 'command', {
    command: ['npm', 'test'],
  });
  workflows.completeOperation(run.id, 'tests', {
    ok: true,
    stdout: 'passed',
  });

  const loaded = workflows.getRun(run.id);
  assert.equal(loaded.bundledSource, 'compiled source');
  assert.equal(loaded.operations[0].key, 'tests');
  assert.deepEqual(loaded.operations[0].output, {
    ok: true,
    stdout: 'passed',
  });
  goals.close();
});

test('rejects changed operation input during replay', () => {
  const { goals, workflows } = stores();
  const run = workflows.createRun({
    taskId: 'task-1',
    workflowName: 'verify',
    sourcePath: '/workflow.ts',
    sourceHash: 'abc',
    bundledSource: 'source',
    input: {},
  });
  workflows.startOperation(run.id, 'tests', 'command', {
    command: ['npm', 'test'],
  });

  assert.throws(
    () =>
      workflows.startOperation(run.id, 'tests', 'command', {
        command: ['npm', 'run', 'test'],
      }),
    /changed during replay/,
  );
  goals.close();
});
