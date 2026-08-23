import type { DisplayTool } from '../claude';

type ToolPhrase = { action: string; completed: string };

const FILE_TOOLS: Record<string, ToolPhrase> = {
  Glob: { action: 'list files', completed: 'Listed files' },
  Grep: { action: 'search files', completed: 'Searched files' },
  Bash: { action: 'run command', completed: 'Ran command' },
};

// The planner reads and researches; it never edits, so an unrecognised tool is
// far more likely to be a read than anything else.
export const plannerToolPhrases: Record<string, ToolPhrase> = {
  ...FILE_TOOLS,
  WebSearch: { action: 'search the web', completed: 'Searched the web' },
  WebFetch: { action: 'fetch page', completed: 'Fetched page' },
  mcp__rba__update_findings: {
    action: 'update findings',
    completed: 'Updated findings',
  },
  mcp__rba__read_findings: {
    action: 'read findings',
    completed: 'Read findings',
  },
  mcp__rba__read_tasks: { action: 'read tasks', completed: 'Read tasks' },
  mcp__rba__add_task: { action: 'draft task', completed: 'Drafted task' },
  mcp__rba__update_task: { action: 'update task', completed: 'Updated task' },
  mcp__rba__remove_task: { action: 'remove task', completed: 'Removed task' },
  mcp__rba__commit_tasks: { action: 'queue tasks', completed: 'Queued tasks' },
};

export const workerToolPhrases: Record<string, ToolPhrase> = {
  ...FILE_TOOLS,
  Read: { action: 'read file', completed: 'Read file' },
  Edit: { action: 'edit file', completed: 'Edited file' },
  Write: { action: 'write file', completed: 'Wrote file' },
};

const PLANNER_FALLBACK: ToolPhrase = {
  action: 'read file',
  completed: 'Read file',
};
const WORKER_FALLBACK: ToolPhrase = {
  action: 'use tool',
  completed: 'Used tool',
};

function capitalise(text: string) {
  return `${text[0].toUpperCase()}${text.slice(1)}`;
}

function createToolLabel(
  phrases: Record<string, ToolPhrase>,
  fallback: ToolPhrase,
) {
  return (tool: DisplayTool) => {
    const { action, completed } = phrases[tool.name] ?? fallback;

    if (tool.status === 'running') {
      return `${capitalise(action)}…`;
    }

    if (tool.status === 'cancelled') {
      return `${capitalise(action)} stopped`;
    }

    if (tool.status === 'error') {
      return `Could not ${action}`;
    }

    return completed;
  };
}

export const plannerToolLabel = createToolLabel(
  plannerToolPhrases,
  PLANNER_FALLBACK,
);
export const workerToolLabel = createToolLabel(
  workerToolPhrases,
  WORKER_FALLBACK,
);

export function toolDetail(tool: DisplayTool) {
  if (!tool.input) {
    return null;
  }

  const value =
    tool.name === 'Glob' || tool.name === 'Grep'
      ? tool.input.pattern
      : tool.name === 'Bash'
        ? tool.input.command
        : tool.name === 'WebSearch'
          ? tool.input.query
          : tool.name === 'WebFetch'
            ? tool.input.url
            : tool.input.file_path;
  return typeof value === 'string' ? value : null;
}
