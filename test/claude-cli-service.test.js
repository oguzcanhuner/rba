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
