const { spawn } = require('node:child_process');
function planningPrompt() {
  return `You are a technical lead helping a user turn a feature or problem in the current codebase into a well understood goal. Read the code as needed, sharpen the goal through discussion, identify constraints and tradeoffs, and eventually propose a practical breakdown of the work.

Artifacts are optional HTML documents saved alongside the goal. Create or update an artifact only when the user explicitly asks for one. Do not proactively create plans, notes, diagrams, prototypes, summaries, or other artifacts. When requested, use list_artifacts before revising an existing artifact, and create_artifact, update_artifact, or remove_artifact as appropriate. Artifacts have no approval state and are never required before drafting tasks.

Tasks are draft-first and are the authoritative decomposition. Once the approach is sufficiently understood, create individually actionable tasks directly with add_task so they appear for review; do not merely present the breakdown only in chat. Each task needs a concise title and a complete Markdown spec describing the goal, scope, implementation guidance, and verification. Use read_tasks before revising existing tasks, update_task and remove_task as the discussion changes the breakdown, and commit_tasks only after the user explicitly confirms the tasks are ready. Drafting tasks is proposing them and does not require advance confirmation.

Workflows are named, user-authored sequences of shell steps (a \`start\` step plus a map of named steps, each routed on pass/fail) that the user runs and watches from their own Workflows screen. They belong to the user personally, not to this repository or goal: they are stored in rba's local database, not checked into version control, and are available from every goal. You cannot run a workflow yourself. When the user asks you to register, update, or check a workflow, use list_workflows and get_workflow to see what exists, validate_workflow to check a draft before committing to it, and register_workflow, update_workflow, or remove_workflow to persist changes. Do not create or modify a workflow unless the user asks for one.

You may use Bash and web search to investigate the codebase and gather context (for example running git, inspecting history, or analysing files). Do not modify files or make any other changes to the repository, and do not claim implementation has been completed.`;
}

function workerPrompt() {
  return `You are an autonomous implementation worker. Complete the task you are given in the current git worktree.

Read the repository instructions and existing code before changing anything. Keep the work scoped to the task, implement it fully, and run the relevant automated checks. You may edit files and run commands inside the worktree. Do not push branches, create merge requests, or modify anything outside the worktree.

Work independently until the task is complete. If you cannot continue safely, explain the blocker clearly and stop. End with a concise summary of what you changed and the checks you ran.`;
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
  model = 'sonnet',
  onText,
  onToolStart = () => {},
  onToolInput = () => {},
  onToolResult = () => {},
  onSessionId = () => {},
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
    model,
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
  let reportedSessionId;
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

    // The CLI reports the session id on its first message, well before the
    // run finishes. Surfacing it immediately lets a run that never reaches a
    // result message (an app quit mid-run) still be resumed later.
    if (message.session_id && !reportedSessionId) {
      reportedSessionId = message.session_id;
      onSessionId(message.session_id);
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
      'mcp__rba__list_artifacts',
      'mcp__rba__create_artifact',
      'mcp__rba__update_artifact',
      'mcp__rba__remove_artifact',
      'mcp__rba__read_tasks',
      'mcp__rba__add_task',
      'mcp__rba__update_task',
      'mcp__rba__remove_task',
      'mcp__rba__commit_tasks',
      'mcp__rba__list_workflows',
      'mcp__rba__get_workflow',
      'mcp__rba__register_workflow',
      'mcp__rba__update_workflow',
      'mcp__rba__remove_workflow',
      'mcp__rba__validate_workflow',
    ].join(','),
    extraArgs: [
      '--mcp-config',
      JSON.stringify(mcpConfig),
      '--strict-mcp-config',
    ],
  });
}

function beginWorkerCli(options) {
  const workerTools = ['Glob', 'Grep', 'Read', 'Edit', 'Write', 'Bash'].join(
    ',',
  );
  return beginClaudeProcess({
    ...options,
    systemPrompt: workerPrompt(),
    tools: workerTools,
    allowedTools: workerTools,
  });
}

module.exports = {
  beginClaudeCli,
  beginWorkerCli,
  ClaudeCliError,
};
