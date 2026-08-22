const vm = require('node:vm');

const pending = new Map();

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

function context(input) {
  return {
    input,
    task: input.task,
    command: (key, options) => operation('command', key, options),
    agent: (key, options) => operation('agent', key, options),
    human: (key, options) => operation('human', key, options),
    sleep: (key, options) => operation('sleep', key, options),
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
