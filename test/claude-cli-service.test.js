const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { test } = require('node:test');
const { beginClaudeCli, beginWorkerCli } = require('../claude-cli-service');

function fakeProcess() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = (signal) => {
    child.killedWith = signal;
    return true;
  };
  return child;
}

test('streams text from Claude CLI JSON output', async () => {
  const child = fakeProcess();
  let invocation;
  const deltas = [];
  const spawnProcess = (command, args, options) => {
    invocation = { command, args, options };
    return child;
  };
  const response = beginClaudeCli({
    prompt: 'Hello',
    cwd: '/workspace',
    findingsServer: {
      command: '/electron',
      script: '/app/findings-mcp-server.js',
      env: { ELECTRON_RUN_AS_NODE: '1' },
    },
    explorationDatabase: '/app-data/explorations.sqlite3',
    explorationId: 'exploration-1',
    onText: (text) => deltas.push(text),
    spawnProcess,
    environment: { PATH: '/bin', CLAUDE_CONFIG_DIR: '/claude-config' },
  });

  child.stdout.write(
    `${JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'Hello' },
      },
    })}\n`,
  );
  child.stdout.write(
    `${JSON.stringify({
      type: 'result',
      subtype: 'success',
      session_id: 'session-123',
    })}\n`,
  );
  child.emit('close', 0);

  assert.equal(invocation.command, 'claude');
  assert.equal(
    invocation.args[invocation.args.indexOf('--tools') + 1],
    'Glob,Read',
  );
  assert.match(
    invocation.args[invocation.args.indexOf('--append-system-prompt') + 1],
    /Do not write or modify files/,
  );
  assert.match(
    invocation.args[invocation.args.indexOf('--append-system-prompt') + 1],
    /do not ask permission before updating findings/,
  );
  assert.match(
    invocation.args[invocation.args.indexOf('--append-system-prompt') + 1],
    /Skip an update only when the turn produced no durable new understanding/,
  );
  assert.equal(
    invocation.args[invocation.args.indexOf('--allowedTools') + 1],
    [
      'mcp__rba__read_findings',
      'mcp__rba__update_findings',
      'mcp__rba__read_tasks',
      'mcp__rba__add_task',
      'mcp__rba__update_task',
      'mcp__rba__remove_task',
      'mcp__rba__commit_tasks',
    ].join(','),
  );
  const mcpConfig = JSON.parse(
    invocation.args[invocation.args.indexOf('--mcp-config') + 1],
  );
  assert.deepEqual(mcpConfig, {
    mcpServers: {
      rba: {
        command: '/electron',
        args: ['/app/findings-mcp-server.js'],
        env: {
          ELECTRON_RUN_AS_NODE: '1',
          RBA_EXPLORATION_DATABASE: '/app-data/explorations.sqlite3',
          RBA_EXPLORATION_ID: 'exploration-1',
        },
      },
    },
  });
  assert.equal(invocation.args.includes('--safe-mode'), false);
  assert.deepEqual(deltas, ['Hello']);
  assert.deepEqual(invocation.options.env, {
    PATH: '/bin',
    CLAUDE_CONFIG_DIR: '/claude-config',
  });
  assert.deepEqual(await response.completion, { sessionId: 'session-123' });
});

test('resumes an existing CLI session and supports cancellation', () => {
  const child = fakeProcess();
  let args;
  const response = beginClaudeCli({
    prompt: 'Continue',
    sessionId: 'session-123',
    cwd: '/workspace',
    findingsServer: { command: '/electron', script: '/app/server.js' },
    explorationDatabase: '/app-data/explorations.sqlite3',
    explorationId: 'exploration-1',
    onText: () => {},
    spawnProcess: (_command, receivedArgs) => {
      args = receivedArgs;
      return child;
    },
  });

  response.cancel();

  assert.deepEqual(args.slice(-2), ['--resume', 'session-123']);
  assert.equal(child.killedWith, 'SIGTERM');
});

test('reports tool input and completion from Claude CLI output', async () => {
  const child = fakeProcess();
  const events = [];
  const response = beginClaudeCli({
    prompt: 'Find package.json',
    cwd: '/workspace',
    findingsServer: { command: '/electron', script: '/app/server.js' },
    explorationDatabase: '/app-data/explorations.sqlite3',
    explorationId: 'exploration-1',
    onText: (text) => events.push({ type: 'text', text }),
    onToolStart: (tool) => events.push({ type: 'start', tool }),
    onToolInput: (tool) => events.push({ type: 'input', tool }),
    onToolResult: (tool) => events.push({ type: 'result', tool }),
    spawnProcess: () => child,
  });

  const messages = [
    {
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: "I'll look through the files." },
      },
    },
    {
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index: 1,
        content_block: {
          type: 'tool_use',
          id: 'tool-123',
          name: 'Glob',
          input: {},
        },
      },
    },
    {
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 1,
        delta: {
          type: 'input_json_delta',
          partial_json: '{"pattern":"**/package.json"}',
        },
      },
    },
    {
      type: 'stream_event',
      event: { type: 'content_block_stop', index: 1 },
    },
    {
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'tool-123' }],
      },
    },
    {
      type: 'result',
      subtype: 'success',
      session_id: 'session-123',
    },
  ];

  child.stdout.end(`${messages.map(JSON.stringify).join('\n')}\n`);
  child.emit('close', 0);

  assert.deepEqual(events, [
    {
      type: 'text',
      text: "I'll look through the files.",
    },
    {
      type: 'start',
      tool: { id: 'tool-123', name: 'Glob' },
    },
    {
      type: 'input',
      tool: { id: 'tool-123', input: { pattern: '**/package.json' } },
    },
    {
      type: 'result',
      tool: { id: 'tool-123', isError: false },
    },
  ]);
  assert.deepEqual(await response.completion, { sessionId: 'session-123' });
});

test('starts an autonomous worker with write and command tools', async () => {
  const child = fakeProcess();
  let args;
  const response = beginWorkerCli({
    prompt: 'Implement the task',
    cwd: '/worktree',
    onText: () => {},
    spawnProcess: (_command, receivedArgs) => {
      args = receivedArgs;
      return child;
    },
  });

  assert.equal(
    args[args.indexOf('--tools') + 1],
    'Glob,Grep,Read,Edit,Write,Bash',
  );
  assert.equal(
    args[args.indexOf('--allowedTools') + 1],
    'Glob,Grep,Read,Edit,Write,Bash',
  );
  assert.match(
    args[args.indexOf('--append-system-prompt') + 1],
    /autonomous implementation worker/,
  );
  assert.equal(args.includes('--mcp-config'), false);

  child.stdout.write(
    `${JSON.stringify({
      type: 'result',
      subtype: 'success',
      session_id: 'worker-session',
    })}\n`,
  );
  child.emit('close', 0);
  assert.deepEqual(await response.completion, {
    sessionId: 'worker-session',
  });
});
