import {
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useRef,
  useState,
} from 'react';
import type { ClaudeStreamEvent, ClaudeToolInput } from './claude';

type MessageStatus = 'streaming' | 'complete' | 'cancelled' | 'error';
type ToolStatus = 'running' | 'complete' | 'cancelled' | 'error';

type DisplayTool = {
  id: string;
  name: string;
  input: ClaudeToolInput;
  status: ToolStatus;
};

type DisplayPart =
  | { type: 'text'; id: string; text: string }
  | { type: 'tool'; tool: DisplayTool };

type DisplayMessage = {
  id: string;
  role: 'user' | 'assistant';
  status: MessageStatus;
  parts: DisplayPart[];
};

function statusLabel(message: DisplayMessage) {
  if (message.status === 'cancelled') {
    return 'Stopped';
  }

  if (message.status === 'error') {
    return 'Interrupted';
  }

  return null;
}

function toolLabel(tool: DisplayTool) {
  const action = tool.name === 'Glob' ? 'list files' : 'read file';

  if (tool.status === 'running') {
    return `${action[0].toUpperCase()}${action.slice(1)}…`;
  }

  if (tool.status === 'cancelled') {
    return `${action[0].toUpperCase()}${action.slice(1)} stopped`;
  }

  if (tool.status === 'error') {
    return `Could not ${action}`;
  }

  return tool.name === 'Glob' ? 'Listed files' : 'Read file';
}

function toolDetail(tool: DisplayTool) {
  if (!tool.input) {
    return null;
  }

  const value =
    tool.name === 'Glob' ? tool.input.pattern : tool.input.file_path;
  return typeof value === 'string' ? value : null;
}

function appendText(
  parts: DisplayPart[],
  text: string,
  requestId: string,
): DisplayPart[] {
  const lastPart = parts.at(-1);

  if (lastPart?.type === 'text') {
    return [
      ...parts.slice(0, -1),
      { type: 'text', id: lastPart.id, text: lastPart.text + text },
    ];
  }

  return [
    ...parts,
    { type: 'text', id: `${requestId}-text-${parts.length}`, text },
  ];
}

function finishTools(parts: DisplayPart[], status: ToolStatus) {
  return parts.map((part) =>
    part.type === 'tool' && part.tool.status === 'running'
      ? { ...part, tool: { ...part.tool, status } }
      : part,
  );
}

export function App() {
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [workingDirectory, setWorkingDirectory] = useState<string | null>(null);
  const [activeRequestId, setActiveRequestId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const endOfMessages = useRef<HTMLDivElement>(null);

  useEffect(() => {
    window.claude
      .getDefaultDirectory()
      .then(setWorkingDirectory)
      .catch(() => {
        setError('The default working directory could not be loaded.');
      });
  }, []);

  useEffect(() => {
    const handleEvent = (event: ClaudeStreamEvent) => {
      if (event.type === 'text-delta') {
        setMessages((current) =>
          current.map((message) =>
            message.id === `assistant-${event.requestId}`
              ? {
                  ...message,
                  parts: appendText(message.parts, event.text, event.requestId),
                }
              : message,
          ),
        );
        return;
      }

      if (event.type === 'tool-start') {
        setMessages((current) =>
          current.map((message) =>
            message.id === `assistant-${event.requestId}`
              ? {
                  ...message,
                  parts: [
                    ...message.parts,
                    {
                      type: 'tool' as const,
                      tool: {
                        id: event.tool.id,
                        name: event.tool.name,
                        input: null,
                        status: 'running' as const,
                      },
                    },
                  ],
                }
              : message,
          ),
        );
        return;
      }

      if (event.type === 'tool-input') {
        setMessages((current) =>
          current.map((message) =>
            message.id === `assistant-${event.requestId}`
              ? {
                  ...message,
                  parts: message.parts.map((part) =>
                    part.type === 'tool' && part.tool.id === event.tool.id
                      ? {
                          ...part,
                          tool: { ...part.tool, input: event.tool.input },
                        }
                      : part,
                  ),
                }
              : message,
          ),
        );
        return;
      }

      if (event.type === 'tool-result') {
        setMessages((current) =>
          current.map((message) =>
            message.id === `assistant-${event.requestId}`
              ? {
                  ...message,
                  parts: message.parts.map((part) =>
                    part.type === 'tool' && part.tool.id === event.tool.id
                      ? {
                          ...part,
                          tool: {
                            ...part.tool,
                            status: event.tool.isError
                              ? ('error' as const)
                              : ('complete' as const),
                          },
                        }
                      : part,
                  ),
                }
              : message,
          ),
        );
        return;
      }

      if (event.type === 'complete') {
        setMessages((current) =>
          current.map((message) =>
            message.id === `assistant-${event.requestId}`
              ? {
                  ...message,
                  status: 'complete',
                  parts: finishTools(message.parts, 'complete'),
                }
              : message,
          ),
        );
      } else if (event.type === 'cancelled') {
        setMessages((current) =>
          current.map((message) =>
            message.id === `assistant-${event.requestId}`
              ? {
                  ...message,
                  status: 'cancelled',
                  parts: finishTools(message.parts, 'cancelled'),
                }
              : message,
          ),
        );
      } else {
        setMessages((current) =>
          current.map((message) =>
            message.id === `assistant-${event.requestId}`
              ? {
                  ...message,
                  status: 'error',
                  parts: finishTools(message.parts, 'error'),
                }
              : message,
          ),
        );
        setError(event.message);
      }

      setActiveRequestId((current) =>
        current === event.requestId ? null : current,
      );
    };

    return window.claude.onEvent(handleEvent);
  }, []);

  useEffect(() => {
    if (messages.length > 0) {
      endOfMessages.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages]);

  function submitMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const content = draft.trim();
    if (!content || activeRequestId || !workingDirectory) {
      return;
    }

    const requestId = crypto.randomUUID();
    const userMessage: DisplayMessage = {
      id: `user-${requestId}`,
      role: 'user',
      status: 'complete',
      parts: [{ type: 'text', id: `${requestId}-text-0`, text: content }],
    };
    const assistantMessage: DisplayMessage = {
      id: `assistant-${requestId}`,
      role: 'assistant',
      status: 'streaming',
      parts: [],
    };
    setMessages((current) => [...current, userMessage, assistantMessage]);
    setDraft('');
    setError(null);
    setActiveRequestId(requestId);
    window.claude.start({
      requestId,
      prompt: content,
      cwd: workingDirectory,
    });
  }

  async function chooseWorkingDirectory() {
    try {
      const directory = await window.claude.pickDirectory();

      if (directory && directory !== workingDirectory) {
        setWorkingDirectory(directory);
        setMessages([]);
        setError(null);
      }
    } catch {
      setError('A working directory could not be selected.');
    }
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (
      event.key === 'Enter' &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  function cancelResponse() {
    if (activeRequestId) {
      window.claude.cancel(activeRequestId);
    }
  }

  return (
    <main className="chat">
      <header className="chat__header">
        <h1>RBA</h1>
        <span>Claude CLI · Sonnet</span>
      </header>

      <section className="messages" aria-live="polite">
        {messages.length === 0 ? (
          <div className="empty-state">
            <h2>Chat with Claude</h2>
            <p>Send a message to start a conversation.</p>
          </div>
        ) : (
          messages.map((message) => {
            const label = statusLabel(message);

            return (
              <article
                className={`message message--${message.role}`}
                key={message.id}
              >
                <div className="message__role">
                  {message.role === 'user' ? 'You' : 'Claude'}
                </div>
                {message.parts.length > 0 ? (
                  message.parts.map((part) => {
                    if (part.type === 'text') {
                      return (
                        <div
                          className="message__part message__content"
                          key={part.id}
                        >
                          {part.text}
                        </div>
                      );
                    }

                    const tool = part.tool;
                    const detail = toolDetail(tool);

                    return (
                      <div
                        className={`message__part tool-use tool-use--${tool.status}`}
                        key={tool.id}
                      >
                        <span className="tool-use__indicator" />
                        <span className="tool-use__label">
                          {toolLabel(tool)}
                        </span>
                        {detail && (
                          <code className="tool-use__detail">{detail}</code>
                        )}
                      </div>
                    );
                  })
                ) : (
                  <div className="message__content">
                    <span className="thinking">Thinking…</span>
                  </div>
                )}
                {label && <div className="message__status">{label}</div>}
              </article>
            );
          })
        )}
        <div ref={endOfMessages} />
      </section>

      <footer className="composer-area">
        {error && <div className="error-message">{error}</div>}
        <div className="working-directory">
          <span title={workingDirectory ?? undefined}>
            Working directory: {workingDirectory ?? 'Loading…'}
          </span>
          <button
            type="button"
            disabled={activeRequestId !== null}
            onClick={chooseWorkingDirectory}
          >
            Choose folder
          </button>
        </div>
        <form className="composer" onSubmit={submitMessage}>
          <textarea
            aria-label="Message Claude"
            disabled={activeRequestId !== null}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={handleComposerKeyDown}
            placeholder="Message Claude"
            rows={3}
            value={draft}
          />
          {activeRequestId ? (
            <button type="button" onClick={cancelResponse}>
              Stop
            </button>
          ) : (
            <button type="submit" disabled={!draft.trim() || !workingDirectory}>
              Send
            </button>
          )}
        </form>
        <p className="composer-hint">
          Enter to send · Shift+Enter for a new line
        </p>
      </footer>
    </main>
  );
}
