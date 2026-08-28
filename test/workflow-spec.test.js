const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  validateWorkflowName,
  validateDefinition,
  normaliseDefinition,
  nextStep,
} = require('../workflow-spec');

function validDefinition() {
  return {
    start: 'build',
    steps: {
      build: { run: 'npm run build', onPass: 'review', onFail: 'fix' },
      review: { run: 'claude -p "review"', parse: 'json', next: 'done' },
      fix: { run: 'npm run fix', next: 'build' },
      done: { type: 'terminal' },
    },
  };
}

test('validateWorkflowName accepts lowercase, digits, dash, underscore', () => {
  assert.equal(validateWorkflowName('ship-task_v2'), true);
  assert.equal(validateWorkflowName('Ship-Task'), false);
  assert.equal(validateWorkflowName(''), false);
  assert.equal(validateWorkflowName('a'.repeat(65)), false);
});

test('accepts a valid definition', () => {
  const result = validateDefinition(validDefinition());
  assert.deepEqual(result, { ok: true });
});

test('rejects a missing start step', () => {
  const definition = validDefinition();
  definition.start = 'missing';
  const result = validateDefinition(definition);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes('missing')));
});

test('rejects a route to a missing step with a named message', () => {
  const definition = validDefinition();
  definition.steps.review.onFail = 'fixx';
  const result = validateDefinition(definition);
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((error) =>
      error.includes('`review` routes on_fail to missing step `fixx`'),
    ),
  );
});

test('rejects a step with neither next nor on_pass', () => {
  const definition = validDefinition();
  delete definition.steps.build.onPass;
  definition.steps.build.onFail = 'fix';
  const result = validateDefinition(definition);
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((error) =>
      error.includes(
        '`build` has neither `next` nor `on_pass`; add one or set type = "terminal"',
      ),
    ),
  );
});

test('rejects a non-terminal step without run', () => {
  const definition = validDefinition();
  delete definition.steps.build.run;
  const result = validateDefinition(definition);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes('`build`')));
});

test('rejects a terminal step with run or routes', () => {
  const definition = validDefinition();
  definition.steps.done.run = 'echo hi';
  definition.steps.done.next = 'build';
  const result = validateDefinition(definition);
  assert.equal(result.ok, false);
  assert.ok(result.errors.length >= 2);
});

test('rejects unreachable terminal steps', () => {
  const definition = validDefinition();
  definition.steps.build.onPass = 'build';
  definition.steps.build.onFail = 'build';
  definition.steps.review = undefined;
  delete definition.steps.review;
  delete definition.steps.fix;
  const result = validateDefinition(definition);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes('No terminal step')));
});

test('rejects unknown step keys', () => {
  const definition = validDefinition();
  definition.steps.build.on_success = 'review';
  const result = validateDefinition(definition);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes('on_success')));
});

test('rejects invalid parse, maxVisits, and timeoutMs values', () => {
  const definition = validDefinition();
  definition.steps.build.parse = 'yaml';
  definition.steps.build.maxVisits = 0;
  definition.steps.build.timeoutMs = 4_000_000;
  const result = validateDefinition(definition);
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 3);
});

test('rejects more than 100 steps', () => {
  const definition = validDefinition();
  for (let i = 0; i < 100; i += 1) {
    definition.steps[`extra-${i}`] = { run: 'true', next: 'done' };
  }
  const result = validateDefinition(definition);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes('100 steps')));
});

test('normaliseDefinition accepts snake_case step keys', () => {
  const definition = {
    start: 'build',
    steps: {
      build: {
        run: 'npm test',
        on_pass: 'done',
        on_fail: 'done',
        max_visits: 3,
        timeout_ms: 60_000,
      },
      done: { type: 'terminal' },
    },
  };
  const normalised = normaliseDefinition(definition);
  assert.equal(normalised.steps.build.onPass, 'done');
  assert.equal(normalised.steps.build.onFail, 'done');
  assert.equal(normalised.steps.build.maxVisits, 3);
  assert.equal(normalised.steps.build.timeoutMs, 60_000);
  assert.equal(validateDefinition(definition).ok, true);
});

test('nextStep routes pass and fail independently', () => {
  const step = { run: 'x', onPass: 'review', onFail: 'fix' };
  assert.deepEqual(nextStep(step, 'pass'), { ok: true, next: 'review' });
  assert.deepEqual(nextStep(step, 'fail'), { ok: true, next: 'fix' });
});

test('nextStep prefers onPass over next', () => {
  const step = { run: 'x', next: 'a', onPass: 'b' };
  assert.deepEqual(nextStep(step, 'pass'), { ok: true, next: 'b' });
});

test('nextStep reports a missing route', () => {
  const step = { run: 'x', next: 'review' };
  const result = nextStep(step, 'fail');
  assert.equal(result.ok, false);
  assert.ok(result.error.includes('fail'));
});
