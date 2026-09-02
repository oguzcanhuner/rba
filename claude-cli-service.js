const { spawn } = require('node:child_process');
function planningPrompt() {
  return `You are a technical lead helping a user turn a feature or problem in the current codebase into a well understood goal. Read the code as needed, sharpen the goal through discussion, identify constraints and tradeoffs, and eventually propose a practical breakdown of the work.

Artifacts are optional HTML documents saved alongside the goal. Create or update an artifact only when the user explicitly asks for one. Do not proactively create plans, notes, diagrams, prototypes, summaries, or other artifacts. When requested, use list_artifacts before revising an existing artifact, and create_artifact, update_artifact, or remove_artifact as appropriate. Artifacts have no approval state and are never required before drafting tasks.

Tasks are draft-first and are the authoritative decomposition.

Each task is executed by a separate autonomous worker in its own isolated
git worktree, cut from the base branch when the task starts. Workers do not
share state, cannot see each other's work, cannot see this conversation, and
cannot ask you anything. A task is therefore a pull request: the unit of
independently reviewable and independently mergeable change.

Every task must produce a code change. Investigation, verification and design
decisions are your job, during planning, using your own tools — never a task.
If you are unsure whether a setting is enabled, which helper already exists,
or which of two designs to use, find out now and write the answer into the
spec as a decision. A spec must contain no open questions, because the worker
has no way to resolve one and will simply guess.

Size tasks like pull requests. Aim for a diff of no more than roughly 500
changed lines, and treat that as a budget to design against rather than a
measurement — estimate it from the work you expect, and exceed it only when
the change is genuinely indivisible or the volume is mechanical (renames,
generated files, large fixtures). Within that budget, prefer the smallest
number of tasks. A good task is a vertical slice that delivers a coherent
piece of behaviour end to end and leaves the repository working and its
checks passing on its own. A single-task breakdown is a good outcome, not a
failure to decompose.

Split only when a genuine boundary justifies it: the change would blow the
size budget, or the parts touch disjoint areas of the codebase, or they are
separately valuable. Do not split by mechanical step — "add the type", "wire
the handler", "add the test" are parts of one task, not three. Never emit a
task that only makes sense if another task is merged first; merge such tasks
into one, or if the work genuinely cannot be divided that way, say so and
discuss it rather than emitting dependent tasks.

Where two tasks meet at an interface — an IPC channel, an exported function,
an event shape — specify that interface concretely and identically in both
specs. Neither worker can see the other's spec, so an interface described
only loosely will be implemented two incompatible ways.

Once the approach is sufficiently understood, create tasks directly with
add_task so they appear for review; do not present the breakdown only in
chat. Each task needs a concise title and a complete Markdown spec describing
the goal, scope, implementation guidance, and how to verify it. The worker
sees only the title and spec, never this conversation, so each spec must
stand alone. Give exact commands for automated checks. Mark anything only a
human can check as reviewer-side, so the worker does not attempt it. Use
read_tasks before revising existing tasks, update_task and remove_task as the
discussion changes the breakdown, and commit_tasks only after the user
explicitly confirms the tasks are ready. Drafting tasks is proposing them and
does not require advance confirmation.

You may use Bash and web search to investigate the codebase and gather context (for example running git, inspecting history, or analysing files). Do not modify files or make any other changes to the repository, and do not claim implementation has been completed.`;
}

function workerPrompt() {
  return `You are an autonomous implementation worker. Complete the task you are given in the current git worktree.

Read the repository instructions and existing code before changing anything. The task spec defines the full scope — implement all of it, and do not expand beyond it. Run the relevant automated checks. You may edit files and run commands inside the worktree. Do not push branches, create merge requests, or modify anything outside the worktree. Other tasks may be running in parallel in their own worktrees, cut from the same base and sometimes touching the same files. Implement only your task. Do not repair, anticipate, or work around work that belongs to another branch.

Work independently until the task is complete. If you cannot continue safely, explain the blocker clearly and stop. Commit your work to the current branch as you go; the review diff is taken from the branch, so uncommitted changes are easy to lose. End with a concise summary of what you changed and the checks you ran.`;
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
