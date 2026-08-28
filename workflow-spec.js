const NAME_PATTERN = /^[a-z0-9_-]{1,64}$/;
const KNOWN_STEP_KEYS = new Set([
  'run',
  'type',
  'parse',
  'next',
  'onPass',
  'onFail',
  'maxVisits',
  'timeoutMs',
]);
const MAX_STEPS = 100;
const MAX_MAX_VISITS = 100;
const MAX_TIMEOUT_MS = 3_600_000;

function validateWorkflowName(name) {
  return typeof name === 'string' && NAME_PATTERN.test(name);
}

/** Accepts both snake_case (`on_pass`, `max_visits`) and camelCase step keys
 * so an agent reaching for snake_case isn't punished. */
function normaliseStep(step) {
  if (!step || typeof step !== 'object') {
    return step;
  }
  const {
    on_pass: onPassSnake,
    on_fail: onFailSnake,
    max_visits: maxVisitsSnake,
    timeout_ms: timeoutMsSnake,
    onPass,
    onFail,
    maxVisits,
    timeoutMs,
    ...rest
  } = step;
  const normalised = { ...rest };
  if (onPass !== undefined || onPassSnake !== undefined) {
    normalised.onPass = onPass ?? onPassSnake;
  }
  if (onFail !== undefined || onFailSnake !== undefined) {
    normalised.onFail = onFail ?? onFailSnake;
  }
  if (maxVisits !== undefined || maxVisitsSnake !== undefined) {
    normalised.maxVisits = maxVisits ?? maxVisitsSnake;
  }
  if (timeoutMs !== undefined || timeoutMsSnake !== undefined) {
    normalised.timeoutMs = timeoutMs ?? timeoutMsSnake;
  }
  return normalised;
}

function normaliseDefinition(definition) {
  if (!definition || typeof definition !== 'object') {
    return definition;
  }
  const steps = {};
  for (const [name, step] of Object.entries(definition.steps ?? {})) {
    steps[name] = normaliseStep(step);
  }
  return { start: definition.start, steps };
}

function validateDefinition(rawDefinition) {
  const errors = [];
  const definition = normaliseDefinition(rawDefinition);

  if (!definition || typeof definition !== 'object') {
    return {
      ok: false,
      errors: ['The workflow definition must be an object.'],
    };
  }

  const steps = definition.steps;
  if (!steps || typeof steps !== 'object' || Array.isArray(steps)) {
    return {
      ok: false,
      errors: ['The workflow must define a `steps` object.'],
    };
  }

  const stepNames = Object.keys(steps);
  if (stepNames.length === 0) {
    errors.push('The workflow must define at least one step.');
  }
  if (stepNames.length > MAX_STEPS) {
    errors.push(`The workflow defines more than ${MAX_STEPS} steps.`);
  }
  for (const name of stepNames) {
    if (!validateWorkflowName(name)) {
      errors.push(
        `Step name \`${name}\` must use only lowercase letters, digits, \`-\`, or \`_\` (1-64 characters).`,
      );
    }
  }

  if (typeof definition.start !== 'string' || definition.start.length === 0) {
    errors.push('The workflow must name a `start` step.');
  } else if (!steps[definition.start]) {
    errors.push(`\`start\` names missing step \`${definition.start}\`.`);
  }

  for (const [name, step] of Object.entries(steps)) {
    if (!step || typeof step !== 'object' || Array.isArray(step)) {
      errors.push(`\`${name}\` must be an object.`);
      continue;
    }

    for (const key of Object.keys(step)) {
      if (!KNOWN_STEP_KEYS.has(key)) {
        errors.push(`\`${name}\` has unknown key \`${key}\`.`);
      }
    }

    const isTerminal = step.type === 'terminal';
    if (step.type !== undefined && step.type !== 'terminal') {
      errors.push(
        `\`${name}\` has invalid \`type\`; only \`terminal\` is allowed.`,
      );
    }

    if (isTerminal) {
      if (step.run !== undefined) {
        errors.push(`\`${name}\` is terminal and must not have \`run\`.`);
      }
      if (
        step.next !== undefined ||
        step.onPass !== undefined ||
        step.onFail !== undefined
      ) {
        errors.push(`\`${name}\` is terminal and must not have routes.`);
      }
    } else {
      if (typeof step.run !== 'string' || step.run.trim().length === 0) {
        errors.push(`\`${name}\` must have a non-empty \`run\` command.`);
      }

      const hasPassRoute = step.next !== undefined || step.onPass !== undefined;
      if (!hasPassRoute) {
        errors.push(
          `\`${name}\` has neither \`next\` nor \`on_pass\`; add one or set type = "terminal"`,
        );
      }
    }

    if (step.parse !== undefined && step.parse !== 'json') {
      errors.push(
        `\`${name}\` has invalid \`parse\`; only \`json\` is allowed.`,
      );
    }

    if (step.maxVisits !== undefined) {
      if (
        !Number.isInteger(step.maxVisits) ||
        step.maxVisits < 1 ||
        step.maxVisits > MAX_MAX_VISITS
      ) {
        errors.push(
          `\`${name}\` has invalid \`max_visits\`; it must be a positive integer up to ${MAX_MAX_VISITS}.`,
        );
      }
    }

    if (step.timeoutMs !== undefined) {
      if (
        !Number.isInteger(step.timeoutMs) ||
        step.timeoutMs < 1 ||
        step.timeoutMs > MAX_TIMEOUT_MS
      ) {
        errors.push(
          `\`${name}\` has invalid \`timeout_ms\`; it must be a positive integer up to ${MAX_TIMEOUT_MS}.`,
        );
      }
    }

    for (const [routeKey, routeName] of [
      ['next', step.next],
      ['on_pass', step.onPass],
      ['on_fail', step.onFail],
    ]) {
      if (routeName === undefined) {
        continue;
      }
      if (typeof routeName !== 'string' || !steps[routeName]) {
        errors.push(
          `\`${name}\` routes ${routeKey} to missing step \`${routeName}\`.`,
        );
      }
    }
  }

  if (errors.length === 0) {
    const reachable = new Set();
    const queue = [definition.start];
    while (queue.length > 0) {
      const current = queue.pop();
      if (reachable.has(current)) {
        continue;
      }
      reachable.add(current);
      const step = steps[current];
      if (!step || step.type === 'terminal') {
        continue;
      }
      for (const next of [step.onPass, step.next, step.onFail]) {
        if (next && !reachable.has(next)) {
          queue.push(next);
        }
      }
    }

    const reachesTerminal = [...reachable].some(
      (name) => steps[name]?.type === 'terminal',
    );
    if (!reachesTerminal) {
      errors.push(
        'No terminal step is reachable from `start`; the workflow can only run forever.',
      );
    }
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

function nextStep(step, status) {
  if (status === 'pass') {
    const target = step.onPass ?? step.next;
    if (!target) {
      return { ok: false, error: 'No pass route is defined for this step.' };
    }
    return { ok: true, next: target };
  }

  if (status === 'fail') {
    if (!step.onFail) {
      return { ok: false, error: 'No fail route is defined for this step.' };
    }
    return { ok: true, next: step.onFail };
  }

  return { ok: false, error: `Unknown step status \`${status}\`.` };
}

module.exports = {
  validateWorkflowName,
  validateDefinition,
  normaliseDefinition,
  nextStep,
};
