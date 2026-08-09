import {
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useRef,
  useState,
} from 'react';
import type { ClaudeMessage, ClaudeStreamEvent } from './claude';

type MessageStatus = 'streaming' | 'complete' | 'cancelled' | 'error';

type DisplayMessage = ClaudeMessage & {
  id: string;
  status: MessageStatus;
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
              ? { ...message, content: message.content + event.text }
              : message,
          ),
        );
        return;
      }

      if (event.type === 'complete') {
        setMessages((current) =>
          current.map((message) =>
            message.id === `assistant-${event.requestId}`
              ? { ...message, status: 'complete' }
              : message,
          ),
        );
      } else if (event.type === 'cancelled') {
        setMessages((current) =>
          current.map((message) =>
            message.id === `assistant-${event.requestId}`
              ? { ...message, status: 'cancelled' }
              : message,
          ),
        );
      } else {
        setMessages((current) =>
          current.map((message) =>
            message.id === `assistant-${event.requestId}`
              ? { ...message, status: 'error' }
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
      content,
      status: 'complete',
    };
    const assistantMessage: DisplayMessage = {
      id: `assistant-${requestId}`,
      role: 'assistant',
      content: '',
      status: 'streaming',
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
                <div className="message__content">
                  {message.content || (
                    <span className="thinking">Thinking…</span>
                  )}
                </div>
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
