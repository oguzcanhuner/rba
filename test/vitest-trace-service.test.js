const assert = require('node:assert/strict');
const {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  realpathSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { runTestTrace } = require('../test-trace-service');

test('detects and runs the workspace Vitest adapter', async (t) => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'rba-vitest-test-'));
  t.after(() => rmSync(workspace, { force: true, recursive: true }));
  const packageDirectory = path.join(workspace, 'server');
  const executable = path.join(workspace, 'node_modules', '.bin', 'vitest');
  mkdirSync(path.join(packageDirectory, 'src'), { recursive: true });
  mkdirSync(path.dirname(executable), { recursive: true });
  writeFileSync(
    path.join(packageDirectory, 'package.json'),
    JSON.stringify({ devDependencies: { vitest: '^2.1.0' } }),
  );
  writeFileSync(path.join(packageDirectory, 'src', 'feature.test.ts'), 'test');
  writeFileSync(executable, '#!/bin/sh\n');
  chmodSync(executable, 0o755);

  let invocation;
  const trace = await runTestTrace(
    {
      workingDirectory: workspace,
      testPath: 'server/src/feature.test.ts',
      testName: 'returns (the) feature',
    },
    {
      runProcess: async (command, args, options) => {
        invocation = { command, args, options };
        const outputFile = args
          .find((arg) => arg.startsWith('--outputFile='))
          .slice('--outputFile='.length);
        writeFileSync(
          outputFile,
          JSON.stringify({
            success: true,
            startTime: Date.now() - 12,
            testResults: [
              {
                assertionResults: [
                  {
                    fullName: 'feature returns the feature',
                    status: 'passed',
                    duration: 4,
                    failureMessages: [],
                    location: { line: 4, column: 3 },
                  },
                ],
              },
            ],
          }),
        );
      },
    },
  );

  assert.equal(invocation.command, realpathSync(executable));
  assert.equal(invocation.options.cwd, realpathSync(packageDirectory));
  assert.deepEqual(invocation.args.slice(0, 2), ['run', 'src/feature.test.ts']);
  assert.deepEqual(invocation.args.slice(-2), [
    '--testNamePattern',
    'returns \\(the\\) feature',
  ]);
  assert.equal(trace.success, true);
  assert.equal(trace.framework, 'vitest');
  assert.equal(trace.testPath, 'server/src/feature.test.ts');
  assert.equal(trace.testName, 'returns (the) feature');
  assert.deepEqual(trace.assertions, [
    {
      name: 'feature returns the feature',
      status: 'passed',
      durationMs: 4,
      location: { line: 4, column: 3 },
      failures: [],
    },
  ]);
});
