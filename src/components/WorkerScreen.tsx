import { useEffect, useRef } from 'react';
import type { DisplayPart, WorkerRun } from '../claude';
import { MarkdownContent } from './MarkdownContent';
import { Button } from './ui/button';

type WorkerScreenProps = {
  run: WorkerRun;
  onBack: () => void;
  onStop: () => void;
};

function toolAction(name: string) {
  const actions: Record<string, string> = {
    Glob: 'list files',
    Grep: 'search files',
    Read: 'read file',
    Edit: 'edit file',
    Write: 'write file',
    Bash: 'run command',
  };
  return actions[name] ?? 'use tool';
}

function toolLabel(tool: Extract<DisplayPart, { type: 'tool' }>['tool']) {
  const action = toolAction(tool.name);
  if (tool.status === 'running') {
    return `${action[0].toUpperCase()}${action.slice(1)}…`;
  }
  if (tool.status === 'cancelled') {
    return `${action[0].toUpperCase()}${action.slice(1)} stopped`;
  }
  if (tool.status === 'error') {
    return `Could not ${action}`;
  }
  const completed: Record<string, string> = {
    Glob: 'Listed files',
    Grep: 'Searched files',
    Read: 'Read file',
    Edit: 'Edited file',
    Write: 'Wrote file',
    Bash: 'Ran command',
  };
  return completed[tool.name] ?? 'Used tool';
}

function toolDetail(tool: Extract<DisplayPart, { type: 'tool' }>['tool']) {
  if (!tool.input) {
    return null;
  }
  const value =
    tool.name === 'Bash'
      ? tool.input.command
      : tool.name === 'Glob' || tool.name === 'Grep'
        ? tool.input.pattern
        : tool.input.file_path;
  return typeof value === 'string' ? value : null;
}

export function WorkerScreen({ run, onBack, onStop }: WorkerScreenProps) {
  const messages = useRef<HTMLElement>(null);

  useEffect(() => {
    const container = messages.current;
    if (container) {
      container.scrollTop = container.scrollHeight;
    }
  });

  return (
    <section className="worker-screen">
      <header className="worker-screen__header">
        <Button type="button" size="sm" variant="ghost" onClick={onBack}>
          ← Exploration
        </Button>
        <h1>{run.title}</h1>
        <span className={`worker-status worker-status--${run.status}`}>
          {run.status}
        </span>
      </header>

      <section
        className="messages worker-screen__messages"
        aria-live="polite"
        ref={messages}
      >
        {run.messages.map((message) => (
          <article className="message message--assistant" key={message.id}>
            <div className="message__role">Worker</div>
            {message.parts.length === 0 && message.status === 'streaming' ? (
              <div className="message__content">
                <span className="thinking">Thinking…</span>
              </div>
            ) : (
              message.parts.map((part) => {
                if (part.type === 'text') {
                  return (
                    <MarkdownContent
                      className="message__part message__content"
                      key={part.id}
                    >
                      {part.text}
                    </MarkdownContent>
                  );
                }

                const detail = toolDetail(part.tool);
                return (
                  <div
                    className={`message__part tool-use tool-use--${part.tool.status}`}
                    key={part.tool.id}
                  >
                    <span className="tool-use__indicator" />
                    <span className="tool-use__label">
                      {toolLabel(part.tool)}
                    </span>
                    {detail && (
                      <code className="tool-use__detail">{detail}</code>
                    )}
                  </div>
                );
              })
            )}
            {message.status === 'cancelled' && (
              <div className="message__status">Stopped</div>
            )}
            {message.status === 'error' && (
              <div className="message__status">Interrupted</div>
            )}
          </article>
        ))}
        {run.error && <div className="error-message">{run.error}</div>}
      </section>

      <footer className="worker-screen__footer">
        <span title={run.worktree}>{run.worktree}</span>
        {run.status === 'working' && (
          <Button type="button" variant="secondary" onClick={onStop}>
            Stop
          </Button>
        )}
      </footer>
    </section>
  );
}
