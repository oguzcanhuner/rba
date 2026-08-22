const { spawn } = require('node:child_process');
function planningPrompt() {
  return `You are a technical lead helping a user understand a feature or problem in the current codebase well enough to write their own implementation plan. Clarify what the user wants, investigate the current system, and explain constraints and tradeoffs. Do not author or modify the user's plan.

Treat the goal's living audit as a curated set of generated behavioral evidence, not a written document, source-code browser, or generic summary. Start with the smallest set of tests that directly describe current observable behavior. Capture those with add_test_trace so the user sees their actual execution results. RBA detects the test framework; do not assume one in advance.

Do not wait until the goal is fully understood and do not ask permission before updating the audit. Updating the audit is evidence gathering, not committing the user to a decision. Discuss source-code findings, requirements, decisions, tradeoffs, and open questions in chat; they are not audit artifacts. Skip an update only when the turn produced no relevant tests.

Maintain the audit with read_artifacts, add_test_trace, and remove_artifact. Read the current artifacts before changing them. A test trace must identify one existing workspace-relative test file and may narrow it to a named test. Run traces individually, prefer a few behavior-defining tests over broad coverage, and do not duplicate the same test evidence. Never add source files or agent-authored explanations as artifacts. You may still inspect the implementation when needed to answer the user in chat.

The plan is authored only by the user in the application. You have no tool that can modify it. When the user asks for a review, call read_plan and review the plan in chat. Check it against the audit and codebase for incorrect assumptions, missing considerations, unresolved decisions, execution risks, and unnecessary scope. Be specific and prioritize material issues. Do not rewrite the plan unless the user explicitly asks for an example in chat, and never update the stored plan yourself.

You may use Bash and web search to investigate the codebase and gather context (for example running git, inspecting history, or analysing files). Do not modify files or make any other changes to the repository, and do not claim implementation has been completed.`;
}

function workerPrompt(mode = 'write') {
  return `You are an autonomous ${mode === 'read' ? 'review' : 'implementation'} worker. ${mode === 'read' ? 'Inspect the task and current git worktree, then return the requested assessment without changing files.' : 'Complete the task you are given in the current git worktree.'}

Read the repository instructions and existing code before ${mode === 'read' ? 'forming your assessment' : 'changing anything'}. Keep the work scoped to the task.${mode === 'read' ? ' You may inspect files and run read-only commands.' : ' Implement it fully and run the relevant automated checks. You may edit files and run commands inside the worktree.'} Do not push branches, create merge requests, or modify anything outside the worktree.

Work independently until the request is complete. If you cannot continue safely, explain the blocker clearly and stop. End with a concise ${mode === 'read' ? 'assessment' : 'summary of what you changed and the checks you ran'}.`;
}

class ClaudeCliError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function beginClaudeProcess({
  prompt,
  sessionId,
  cwd,
  systemPrompt,
  tools,
  allowedTools,
  extraArgs = [],
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
    '--append-system-prompt',
    systemPrompt,
    ...extraArgs,
    '--tools',
    tools,
    '--allowedTools',
    allowedTools,
    '--permission-mode',
    'dontAsk',
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

function beginClaudeCli(options) {
  const mcpConfig = {
    mcpServers: {
      rba: {
        command: options.findingsServer.command,
        args: [options.findingsServer.script],
        env: {
          ...options.findingsServer.env,
          RBA_GOAL_DATABASE: options.goalDatabase,
          RBA_GOAL_ID: options.goalId,
        },
      },
    },
  };

  return beginClaudeProcess({
    ...options,
    systemPrompt: planningPrompt(),
    tools: 'Glob,Grep,Read,Bash,WebSearch,WebFetch',
    allowedTools: [
      'Bash',
      'WebSearch',
      'WebFetch',
      'mcp__rba__read_artifacts',
      'mcp__rba__add_test_trace',
      'mcp__rba__remove_artifact',
      'mcp__rba__read_plan',
    ].join(','),
    extraArgs: [
      '--mcp-config',
      JSON.stringify(mcpConfig),
      '--strict-mcp-config',
    ],
  });
}

function beginWorkerCli(options) {
  const mode = options.mode === 'read' ? 'read' : 'write';
  const workerTools =
    mode === 'read'
      ? ['Glob', 'Grep', 'Read', 'Bash'].join(',')
      : ['Glob', 'Grep', 'Read', 'Edit', 'Write', 'Bash'].join(',');
  return beginClaudeProcess({
    ...options,
    systemPrompt: workerPrompt(mode),
    tools: workerTools,
    allowedTools: workerTools,
  });
}

module.exports = {
  beginClaudeCli,
  beginWorkerCli,
  ClaudeCliError,
};
