const { spawn } = require('node:child_process');

class ClaudeCliError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function beginClaudeCli({
  prompt,
  sessionId,
  cwd,
  onText,
  spawnProcess = spawn,
  environment = process.env,
}) {
  const args = [
    '-p',
    prompt,
    '--output-format',
    'stream-json',
    '--include-partial-messages',
    '--verbose',
    '--safe-mode',
    '--tools',
    '',
    '--model',
    'sonnet',
  ];

  if (sessionId) {
    args.push('--resume', sessionId);
  }

  const child = spawnProcess(environment.CLAUDE_PATH || 'claude', args, {
    cwd,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let buffer = '';
  let stderr = '';
  let result;
  let protocolError;

  function handleLine(line) {
    if (!line.trim()) {
      return;
    }

    let message;

    try {
      message = JSON.parse(line);
    } catch {
      protocolError = new ClaudeCliError(
        'CLI_PROTOCOL_ERROR',
        'Claude CLI returned invalid streaming output.',
      );
      return;
    }

    if (
      message.type === 'stream_event' &&
      message.event?.type === 'content_block_delta' &&
      message.event.delta?.type === 'text_delta'
    ) {
      onText(message.event.delta.text);
    }

    if (message.type === 'result') {
      if (message.subtype === 'success' && message.session_id) {
        result = { sessionId: message.session_id };
      } else {
        protocolError = new ClaudeCliError(
          'CLI_REQUEST_FAILED',
          message.result || `Claude CLI stopped with ${message.subtype}.`,
        );
      }
    }
  }

  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    lines.forEach(handleLine);
  });

  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk.toString()).slice(-4000);
  });

  const completion = new Promise((resolve, reject) => {
    child.once('error', (error) => {
      reject(
        new ClaudeCliError(
          error.code === 'ENOENT' ? 'CLI_NOT_FOUND' : 'CLI_PROCESS_ERROR',
          error.message,
        ),
      );
    });

    child.once('close', (code) => {
      handleLine(buffer);

      if (protocolError) {
        reject(protocolError);
      } else if (code !== 0) {
        reject(
          new ClaudeCliError(
            'CLI_REQUEST_FAILED',
            stderr || `Claude CLI exited with code ${code}.`,
          ),
        );
      } else if (!result) {
        reject(
          new ClaudeCliError(
            'CLI_PROTOCOL_ERROR',
            'Claude CLI completed without a result message.',
          ),
        );
      } else {
        resolve(result);
      }
    });
  });

  return {
    cancel: () => child.kill('SIGTERM'),
    completion,
  };
}

module.exports = {
  beginClaudeCli,
  ClaudeCliError,
};
