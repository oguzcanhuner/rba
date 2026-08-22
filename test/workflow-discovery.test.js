const assert = require('node:assert/strict');
const { mkdtemp, readFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const {
  ensureStarterWorkflow,
  listWorkflows,
} = require('../workflow-discovery');

test('creates an editable project workflow and TypeScript declarations', async () => {
  const project = await mkdtemp(path.join(tmpdir(), 'rba-project-'));
  const starter = await ensureStarterWorkflow(project);
  const workflows = await listWorkflows(project);

  assert.equal(workflows.length, 1);
  assert.equal(workflows[0].name, 'implement');
  assert.match(await readFile(starter, 'utf8'), /ctx\.agent/);
  assert.match(
    await readFile(path.join(project, '.rba', 'workflow.d.ts'), 'utf8'),
    /WorkflowContext/,
  );
});
