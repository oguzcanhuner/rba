const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const {
  StdioClientTransport,
} = require('@modelcontextprotocol/sdk/client/stdio.js');
const {
  FindingsRepository,
  MAX_FINDINGS_LENGTH,
} = require('../findings-mcp-server');
const { ExplorationStore } = require('../exploration-store');

test('findings tools read and update only their exploration in SQLite', (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'rba-findings-test-'));
  const filename = path.join(directory, 'explorations.sqlite3');
  t.after(() => rmSync(directory, { force: true, recursive: true }));

  const store = new ExplorationStore(filename);
  const base = {
    title: 'Explore findings',
    workingDirectory: '/workspace',
    agentSession: null,
    findingsMarkdown: null,
    messages: [],
    createdAt: '2026-08-09T10:00:00.000Z',
    updatedAt: '2026-08-09T10:00:00.000Z',
  };
  store.save({ ...base, id: 'exploration-1' });
  store.save({ ...base, id: 'exploration-2' });

  const repository = new FindingsRepository(filename, 'exploration-1');
  assert.equal(repository.read(), null);
  assert.equal(repository.update('# Findings\n\nA decision.'), true);
  assert.equal(repository.read(), '# Findings\n\nA decision.');
  assert.equal(store.get('exploration-2').findingsMarkdown, null);
  assert.throws(
    () => repository.update('x'.repeat(MAX_FINDINGS_LENGTH + 1)),
    /invalid/,
  );

  repository.close();
  store.close();
});

test('serves read_findings and update_findings over MCP stdio', async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'rba-findings-mcp-test-'));
  const filename = path.join(directory, 'explorations.sqlite3');
  t.after(() => rmSync(directory, { force: true, recursive: true }));

  const store = new ExplorationStore(filename);
  store.save({
    id: 'exploration-1',
    title: 'Explore findings',
    workingDirectory: '/workspace',
    agentSession: null,
    findingsMarkdown: null,
    messages: [],
    createdAt: '2026-08-09T10:00:00.000Z',
    updatedAt: '2026-08-09T10:00:00.000Z',
  });

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(__dirname, '..', 'findings-mcp-server.js')],
    env: {
      RBA_EXPLORATION_DATABASE: filename,
      RBA_EXPLORATION_ID: 'exploration-1',
    },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'rba-test', version: '1.0.0' });
  await client.connect(transport);
  t.after(async () => {
    await client.close();
    store.close();
  });

  const tools = await client.listTools();
  assert.deepEqual(
    tools.tools.map((tool) => tool.name),
    ['read_findings', 'update_findings'],
  );
  assert.equal(
    tools.tools.find((tool) => tool.name === 'update_findings')?.annotations
      ?.destructiveHint,
    true,
  );

  const empty = await client.callTool({ name: 'read_findings' });
  assert.equal(empty.content[0].text, '(the findings document is empty)');

  const updated = await client.callTool({
    name: 'update_findings',
    arguments: { markdown: '# Findings\n\nUpdated through MCP.' },
  });
  assert.equal(updated.isError, undefined);
  assert.equal(
    store.get('exploration-1').findingsMarkdown,
    '# Findings\n\nUpdated through MCP.',
  );
});
