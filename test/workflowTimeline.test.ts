import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { WorkflowDefinition, WorkflowStepRun } from '../src/claude.ts';
import {
  buildWorkflowTimeline,
  workflowRunControls,
} from '../src/lib/workflowTimeline.ts';

test('persisted running runs are resumable when no process is active', () => {
  assert.deepEqual(
    workflowRunControls(
      { id: 'run-1', status: 'running', isActive: false },
      'run-1',
    ),
    { isRunning: false, canResume: true },
  );
  assert.deepEqual(
    workflowRunControls(
      { id: 'run-1', status: 'running', isActive: true },
      'run-1',
    ),
    { isRunning: true, canResume: false },
  );
});

function step(overrides: Partial<WorkflowStepRun>): WorkflowStepRun {
  return {
    id: `step-${Math.random()}`,
    position: 0,
    step: 'build',
    status: 'pass',
    summary: null,
    data: null,
    stdout: '',
    stderr: '',
    exitCode: 0,
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:00:01.000Z',
    ...overrides,
  };
}

function definition(): WorkflowDefinition {
  return {
    start: 'build',
    steps: {
      build: { run: 'npm run build', onPass: 'done', onFail: 'fix' },
      fix: { run: 'npm run fix', next: 'build' },
      done: { type: 'terminal' },
    },
  };
}

test('buildWorkflowTimeline keeps execution order, including a repeated step', () => {
  const steps = [
    step({ id: 's1', position: 0, step: 'build', status: 'fail' }),
    step({ id: 's2', position: 1, step: 'fix', status: 'pass' }),
    step({ id: 's3', position: 2, step: 'build', status: 'pass' }),
  ];

  const timeline = buildWorkflowTimeline(steps, definition());

  assert.deepEqual(
    timeline.map((row) => row.step),
    ['build', 'fix', 'build'],
  );
});

test('buildWorkflowTimeline numbers each visit of a repeated step independently', () => {
  const steps = [
    step({ id: 's1', position: 0, step: 'build', status: 'fail' }),
    step({ id: 's2', position: 1, step: 'fix', status: 'pass' }),
    step({ id: 's3', position: 2, step: 'build', status: 'pass' }),
  ];

  const timeline = buildWorkflowTimeline(steps, definition());

  assert.deepEqual(
    timeline.map((row) => row.visitNumber),
    [1, 1, 2],
  );
});

test('buildWorkflowTimeline labels the route taken for pass and fail', () => {
  const steps = [
    step({ id: 's1', position: 0, step: 'build', status: 'fail' }),
    step({ id: 's2', position: 1, step: 'fix', status: 'pass' }),
    step({ id: 's3', position: 2, step: 'build', status: 'pass' }),
  ];

  const timeline = buildWorkflowTimeline(steps, definition());

  assert.deepEqual(
    timeline.map((row) => row.routeLabel),
    ['fail → fix', '→ build', '→ done'],
  );
});

test('buildWorkflowTimeline has no route label for a running step or a terminal step', () => {
  const steps = [
    step({ id: 's1', position: 0, step: 'build', status: 'running' }),
  ];

  const timeline = buildWorkflowTimeline(steps, definition());
  assert.equal(timeline[0].routeLabel, null);
});

test('buildWorkflowTimeline tolerates a missing definition', () => {
  const steps = [step({ id: 's1' })];
  assert.equal(buildWorkflowTimeline(steps, null)[0].routeLabel, null);
});
