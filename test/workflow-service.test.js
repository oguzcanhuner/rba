const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { mkdtemp, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { GoalStore } = require('../goal-store');
const { WorkflowService } = require('../workflow-service');
const { WorkflowStore } = require('../workflow-store');

function setup() {
  const goals = new GoalStore(':memory:');
  goals.save({
    id: 'goal-1',
    title: 'Workflow goal',
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
  const workflows = new WorkflowStore(goals.database);
  const run = workflows.createRun({
    taskId: 'task-1',
    workflowName: 'test',
    sourcePath: '/repo/test.workflow.ts',
    sourceHash: 'abc',
    bundledSource: 'source',
    branch: 'rba/test',
    worktree: '/worktree',
    baseRevision: 'base',
    input: { task: { id: 'task-1', workspace: '/worktree' } },
  });
  return { goals, workflows, run };
}

function host() {
  const target = new EventEmitter();
  target.messages = [];
  target.send = (message) => target.messages.push(message);
  target.disconnect = () => {};
  target.kill = () => {};
  return target;
}

test('executes command operations and replays their recorded output', async () => {
  const { goals, workflows, run } = setup();
  let executions = 0;
  const service = new WorkflowService({
    store: workflows,
    taskStore: goals,
    worktreesDirectory: '/workers',
    runCommand: async () => {
      executions += 1;
      return { stdout: 'ok\n', stderr: '' };
    },
  });
  const process = host();
  const request = {
    type: 'operation',
    requestId: 'request-1',
    operationType: 'command',
    key: 'tests',
    input: { command: ['npm', 'test'] },
  };

  await service.handleMessage(run.id, process, request);
  await service.handleMessage(run.id, process, {
    ...request,
    requestId: 'request-2',
  });

  assert.equal(executions, 1);
  assert.equal(process.messages.at(-1).output.stdout, 'ok\n');
  goals.close();
});

test('streams and persists a named agent operation', async () => {
  const { goals, workflows, run } = setup();
  let callbacks;
  let finish;
  const service = new WorkflowService({
    store: workflows,
    taskStore: goals,
    worktreesDirectory: '/workers',
    beginAgent: (options) => {
      callbacks = options;
      return {
        cancel: () => {},
        completion: new Promise((resolve) => {
          finish = resolve;
        }),
      };
    },
  });
  const process = host();

  await service.handleMessage(run.id, process, {
    type: 'operation',
    requestId: 'agent-request',
    operationType: 'agent',
    key: 'implement',
    input: { prompt: 'Implement it', session: 'worker' },
  });
  callbacks.onText('Done.');
  finish({ sessionId: 'session-1' });
  await new Promise((resolve) => setImmediate(resolve));

  const operation = workflows.getOperation(run.id, 'implement');
  assert.equal(operation.status, 'completed');
  assert.equal(operation.messages[0].parts[0].text, 'Done.');
  assert.equal(workflows.getAgentSession(run.id, 'worker'), 'session-1');
  goals.close();
});

test('runs a compiled workflow host through command and human operations', async () => {
  const { goals, workflows } = setup();
  goals.database.prepare('DELETE FROM workflow_runs').run();
  const directory = await mkdtemp(path.join(tmpdir(), 'rba-host-'));
  const sourcePath = path.join(directory, 'integration.workflow.ts');
  await writeFile(
    sourcePath,
    `
      import { workflow } from '@rba/workflow';
      export default workflow({
        id: 'integration',
        async run(ctx) {
          const command = await ctx.command('check', { command: ['verify'] });
          const approval = await ctx.human('approval', { title: 'Approve' });
          return { command, approval };
        },
      });
    `,
  );
  let resolveWaiting;
  let resolveComplete;
  const waiting = new Promise((resolve) => {
    resolveWaiting = resolve;
  });
  const complete = new Promise((resolve) => {
    resolveComplete = resolve;
  });
  const service = new WorkflowService({
    store: workflows,
    taskStore: goals,
    worktreesDirectory: '/workers',
    makeDirectory: async () => {},
    runCommand: async (command, args) => {
      if (command === 'git' && args.includes('--show-toplevel')) {
        return { stdout: '/repo\n' };
      }
      if (command === 'git' && args.at(-1) === 'HEAD') {
        return { stdout: 'base\n' };
      }
      if (command === 'git') return { stdout: '' };
      return { stdout: 'verified', stderr: '' };
    },
    onUpdate: (run) => {
      if (run.status === 'waiting') resolveWaiting(run);
      if (run.status === 'completed') resolveComplete(run);
    },
  });

  const started = await service.start('task-1', sourcePath);
  const suspended = await waiting;
  assert.equal(
    suspended.operations.find(({ key }) => key === 'check').output.stdout,
    'verified',
  );
  service.resolveHuman(started.id, 'approval', { approved: true });
  const completed = await complete;

  assert.equal(completed.output.approval.approved, true);
  assert.equal(completed.operations.length, 2);
  service.shutdown();
  goals.close();
});
