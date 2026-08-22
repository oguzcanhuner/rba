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
  mcp__rba__read_artifacts: {
    action: 'read audit artifacts',
    completed: 'Read audit artifacts',
  },
  mcp__rba__add_test_trace: {
    action: 'run test trace',
    completed: 'Added test trace',
  },
  mcp__rba__remove_artifact: {
    action: 'remove audit artifact',
    completed: 'Removed audit artifact',
  },
  mcp__rba__read_plan: {
    action: 'read plan',
    completed: 'Read plan',
  },
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
            : tool.name === 'mcp__rba__add_test_trace'
              ? tool.input.path
              : tool.input.file_path;
  return typeof value === 'string' ? value : null;
}
