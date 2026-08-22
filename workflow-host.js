const vm = require('node:vm');

const pending = new Map();
const seenOperations = new Set();

function loadWorkflow(source, filename) {
  const module = { exports: {} };
  const wrapper = vm.runInThisContext(
    `(function(module, exports, require) {${source}\n})`,
    {
      filename,
    },
  );
  wrapper(module, module.exports, require);
  const definition = module.exports.default ?? module.exports;
  if (!definition || typeof definition.run !== 'function') {
    throw new Error('Workflow must export a definition with a run function.');
  }
  return definition;
}

function operation(type, key, input) {
  if (typeof key !== 'string' || !key.trim() || key.length > 200) {
    throw new Error(
      'Workflow operation IDs must be non-empty strings under 200 characters.',
    );
  }
  if (seenOperations.has(key)) {
    throw new Error(`Workflow operation \`${key}\` was called more than once.`);
  }
  seenOperations.add(key);
  const requestId = `${key}:${crypto.randomUUID()}`;
  return new Promise((resolve, reject) => {
    pending.set(requestId, { resolve, reject });
    process.send({
      type: 'operation',
      requestId,
      operationType: type,
      key,
      input,
    });
  });
}

function context(input, prefix = '') {
  const key = (id) => `${prefix}${id}`;
  return {
    input,
    task: input.task,
    command: (id, options) => operation('command', key(id), options),
    agent: (id, options) => operation('agent', key(id), options),
    human: (id, options) => operation('human', key(id), options),
    sleep: (id, options) => operation('sleep', key(id), options),
    workflow: (id, definition, childInput) => {
      if (!definition || typeof definition.run !== 'function') {
        throw new Error('Child workflows must be workflow definitions.');
      }
      return definition.run(context(childInput, `${key(id)}/`));
    },
  };
}

process.on('message', async (message) => {
  if (message.type === 'operation-result') {
    const request = pending.get(message.requestId);
    if (!request) return;
    pending.delete(message.requestId);
    if (message.error) request.reject(new Error(message.error));
    else request.resolve(message.output);
    return;
  }
  if (message.type !== 'start') return;
  try {
    const definition = loadWorkflow(message.bundledSource, message.sourcePath);
    const output = await definition.run(context(message.input));
    process.send({ type: 'complete', output: output ?? null });
  } catch (error) {
    process.send({
      type: 'failed',
      error:
        error instanceof Error ? (error.stack ?? error.message) : String(error),
    });
  }
});
