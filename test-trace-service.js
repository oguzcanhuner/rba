const {
  runVitestTrace,
  supportsVitestTrace,
} = require('./vitest-trace-service');

const adapters = [
  {
    framework: 'vitest',
    supports: supportsVitestTrace,
    run: runVitestTrace,
  },
];

async function runTestTrace(input, options) {
  for (const adapter of adapters) {
    if (await adapter.supports(input)) {
      return {
        framework: adapter.framework,
        ...(await adapter.run(input, options)),
      };
    }
  }
  throw new Error('No supported test framework was found for this test file.');
}

module.exports = { runTestTrace };
