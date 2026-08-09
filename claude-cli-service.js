const { spawn } = require('node:child_process');

const PLANNING_PROMPT = `You are a technical lead helping a user explore a feature or problem in the current codebase. Read the code as needed, clarify the goal through discussion, identify constraints and tradeoffs, and propose a practical breakdown of the work. Do not write or modify code. Do not claim implementation has been completed.`;

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
  onToolStart = () => {},
  onToolInput = () => {},
  onToolResult = () => {},
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
    '--append-system-prompt',
    PLANNING_PROMPT,
    '--tools',
    'Glob,Read',
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
  const toolBlocks = new Map();

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

    if (
      message.type === 'stream_event' &&
      message.event?.type === 'content_block_start' &&
      message.event.content_block?.type === 'tool_use'
    ) {
      const tool = message.event.content_block;
      toolBlocks.set(message.event.index, {
        id: tool.id,
        input: '',
      });
      onToolStart({ id: tool.id, name: tool.name });
    }

    if (
      message.type === 'stream_event' &&
      message.event?.type === 'content_block_delta' &&
      message.event.delta?.type === 'input_json_delta'
    ) {
      const tool = toolBlocks.get(message.event.index);

      if (tool) {
        tool.input += message.event.delta.partial_json;
      }
    }

    if (
      message.type === 'stream_event' &&
      message.event?.type === 'content_block_stop'
    ) {
      const tool = toolBlocks.get(message.event.index);

      if (tool) {
        try {
          onToolInput({
            id: tool.id,
            input: tool.input ? JSON.parse(tool.input) : {},
          });
        } catch {
          onToolInput({ id: tool.id, input: null });
        }

        toolBlocks.delete(message.event.index);
      }
    }

    if (message.type === 'user' && Array.isArray(message.message?.content)) {
      for (const content of message.message.content) {
        if (content.type === 'tool_result') {
          onToolResult({
            id: content.tool_use_id,
            isError: content.is_error === true,
          });
        }
      }
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
