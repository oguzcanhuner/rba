const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { test } = require('node:test');
const { beginClaudeCli } = require('../claude-cli-service');

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
    /Do not write or modify code/,
  );
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
