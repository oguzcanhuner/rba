const assert = require('node:assert/strict');
const { mkdtemp, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { compileWorkflow } = require('../workflow-compiler');

test('bundles TypeScript workflows with the RBA SDK', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rba-workflow-'));
  const sourcePath = path.join(directory, 'verify.workflow.ts');
  await writeFile(
    sourcePath,
    `
      import { workflow } from '@rba/workflow';
      export default workflow({
        id: 'verify',
        async run(ctx: { command: Function }) {
          return ctx.command('tests', { command: ['npm', 'test'] });
        },
      });
    `,
  );

  const result = await compileWorkflow(sourcePath);
  assert.match(result.bundledSource, /verify/);
  assert.equal(result.sourceHash.length, 64);
});
