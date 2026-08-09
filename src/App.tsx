import {
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useDefaultLayout } from 'react-resizable-panels';
import findingsEmptyIcon from './assets/findings-empty.svg';
import plusIcon from './assets/plus.svg';
import sidebarCollapseIcon from './assets/sidebar-collapse.svg';
import type {
  ClaudeStreamEvent,
  DisplayMessage,
  DisplayPart,
  Exploration,
  ExplorationSummary,
  ToolStatus,
} from './claude';
import { MarkdownContent } from './components/MarkdownContent';
import { Button } from './components/ui/button';
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from './components/ui/resizable';
import { Textarea } from './components/ui/textarea';

function statusLabel(message: DisplayMessage) {
  if (message.status === 'cancelled') {
    return 'Stopped';
  }

  if (message.status === 'error') {
    return 'Interrupted';
  }

  return null;
}

function toolLabel(tool: Extract<DisplayPart, { type: 'tool' }>['tool']) {
  const action =
    tool.name === 'Glob'
      ? 'list files'
      : tool.name === 'mcp__rba__update_findings'
        ? 'update findings'
        : tool.name === 'mcp__rba__read_findings'
          ? 'read findings'
          : 'read file';

  if (tool.status === 'running') {
    return `${action[0].toUpperCase()}${action.slice(1)}…`;
  }

  if (tool.status === 'cancelled') {
    return `${action[0].toUpperCase()}${action.slice(1)} stopped`;
  }

  if (tool.status === 'error') {
    return `Could not ${action}`;
  }

  if (tool.name === 'Glob') {
    return 'Listed files';
  }

  if (tool.name === 'mcp__rba__update_findings') {
    return 'Updated findings';
  }

  return tool.name === 'mcp__rba__read_findings'
    ? 'Read findings'
    : 'Read file';
}

function toolDetail(tool: Extract<DisplayPart, { type: 'tool' }>['tool']) {
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

function explorationTitle(message: string) {
  const title = message.replace(/\s+/g, ' ').trim();
  return title.length <= 60 ? title : `${title.slice(0, 57).trimEnd()}…`;
}

function summaryOf(exploration: Exploration): ExplorationSummary {
  const {
    agentSession: _agentSession,
    findingsMarkdown: _findingsMarkdown,
    messages: _messages,
    ...summary
  } = exploration;
  return summary;
}

function byNewestCreation(left: ExplorationSummary, right: ExplorationSummary) {
  return right.createdAt.localeCompare(left.createdAt);
}

function restoreInterruptedMessages(exploration: Exploration): Exploration {
  return {
    ...exploration,
    messages: exploration.messages.map((message) =>
      message.status === 'streaming'
        ? {
            ...message,
            status: 'error',
            parts: finishTools(message.parts, 'error'),
          }
        : message,
    ),
  };
}

function updateAssistant(
  exploration: Exploration,
  requestId: string,
  update: (message: DisplayMessage) => DisplayMessage,
) {
  return {
    ...exploration,
    updatedAt: new Date().toISOString(),
    messages: exploration.messages.map((message) =>
      message.id === `assistant-${requestId}` ? update(message) : message,
    ),
  };
}

export function App() {
  const workspaceLayout = useDefaultLayout({
    id: 'rba.exploration-workspace',
    panelIds: ['findings', 'chat'],
    storage: window.localStorage,
  });
  const [explorations, setExplorations] = useState<ExplorationSummary[]>([]);
  const [activeExploration, setActiveExploration] =
    useState<Exploration | null>(null);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [draft, setDraft] = useState('');
  const [workingDirectory, setWorkingDirectory] = useState<string | null>(null);
  const [activeRequestId, setActiveRequestId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const endOfMessages = useRef<HTMLDivElement>(null);
  const messages = activeExploration?.messages ?? [];

  useEffect(() => {
    let disposed = false;

    Promise.all([
      window.claude.getDefaultDirectory(),
      window.explorations.list(),
    ])
      .then(async ([defaultDirectory, savedExplorations]) => {
        if (disposed) {
          return;
        }

        setExplorations(savedExplorations);
        const latest = savedExplorations[0];

        if (latest) {
          const saved = await window.explorations.get(latest.id);
          if (!disposed && saved) {
            const restored = restoreInterruptedMessages(saved);
            setActiveExploration(restored);
            setWorkingDirectory(restored.workingDirectory);
          }
        } else {
          setWorkingDirectory(defaultDirectory);
        }
      })
      .catch(() => {
        if (!disposed) {
          setError('Saved explorations could not be loaded.');
        }
      });

    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    if (!activeExploration) {
      return;
    }

    const timeout = window.setTimeout(() => {
      window.explorations
        .save(activeExploration)
        .then(() => {
          const summary = summaryOf(activeExploration);
          setExplorations((current) =>
            [summary, ...current.filter((item) => item.id !== summary.id)].sort(
              byNewestCreation,
            ),
          );
        })
        .catch(() => {
          setError('This exploration could not be saved.');
        });
    }, 150);

    return () => window.clearTimeout(timeout);
  }, [activeExploration]);

  useEffect(() => {
    const handleEvent = (event: ClaudeStreamEvent) => {
      if (event.type === 'findings-updated') {
        setActiveExploration((current) =>
          current
            ? {
                ...current,
                findingsMarkdown: event.markdown,
                updatedAt: new Date().toISOString(),
              }
            : current,
        );
        return;
      }

      if (event.type === 'text-delta') {
        setActiveExploration((current) =>
          current
            ? updateAssistant(current, event.requestId, (message) => ({
                ...message,
                parts: appendText(message.parts, event.text, event.requestId),
              }))
            : current,
        );
        return;
      }

      if (event.type === 'tool-start') {
        setActiveExploration((current) =>
          current
            ? updateAssistant(current, event.requestId, (message) => ({
                ...message,
                parts: [
                  ...message.parts,
                  {
                    type: 'tool',
                    tool: {
                      id: event.tool.id,
                      name: event.tool.name,
                      input: null,
                      status: 'running',
                    },
                  },
                ],
              }))
            : current,
        );
        return;
      }

      if (event.type === 'tool-input') {
        setActiveExploration((current) =>
          current
            ? updateAssistant(current, event.requestId, (message) => ({
                ...message,
                parts: message.parts.map((part) =>
                  part.type === 'tool' && part.tool.id === event.tool.id
                    ? {
                        ...part,
                        tool: { ...part.tool, input: event.tool.input },
                      }
                    : part,
                ),
              }))
            : current,
        );
        return;
      }

      if (event.type === 'tool-result') {
        setActiveExploration((current) =>
          current
            ? updateAssistant(current, event.requestId, (message) => ({
                ...message,
                parts: message.parts.map((part) =>
                  part.type === 'tool' && part.tool.id === event.tool.id
                    ? {
                        ...part,
                        tool: {
                          ...part.tool,
                          status: event.tool.isError ? 'error' : 'complete',
                        },
                      }
                    : part,
                ),
              }))
            : current,
        );
        return;
      }

      if (event.type === 'complete') {
        setActiveExploration((current) => {
          if (!current) {
            return current;
          }

          const now = new Date().toISOString();
          const updated = updateAssistant(
            current,
            event.requestId,
            (message) => ({
              ...message,
              status: 'complete',
              parts: finishTools(message.parts, 'complete'),
            }),
          );
          const existingSession =
            current.agentSession?.provider === 'claude'
              ? current.agentSession
              : null;

          return {
            ...updated,
            agentSession: {
              id: existingSession?.id ?? crypto.randomUUID(),
              provider: 'claude',
              externalId: event.sessionId,
              metadata: existingSession?.metadata ?? {},
              createdAt: existingSession?.createdAt ?? now,
              updatedAt: now,
            },
          };
        });
      } else if (event.type === 'cancelled') {
        setActiveExploration((current) =>
          current
            ? updateAssistant(current, event.requestId, (message) => ({
                ...message,
                status: 'cancelled',
                parts: finishTools(message.parts, 'cancelled'),
              }))
            : current,
        );
      } else {
        setActiveExploration((current) =>
          current
            ? updateAssistant(current, event.requestId, (message) => ({
                ...message,
                status: 'error',
                parts: finishTools(message.parts, 'error'),
              }))
            : current,
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

  async function submitMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const content = draft.trim();
    if (!content || activeRequestId || !workingDirectory) {
      return;
    }

    const requestId = crypto.randomUUID();
    const now = new Date().toISOString();
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
    const exploration: Exploration = activeExploration
      ? {
          ...activeExploration,
          updatedAt: now,
          messages: [
            ...activeExploration.messages,
            userMessage,
            assistantMessage,
          ],
        }
      : {
          id: crypto.randomUUID(),
          title: explorationTitle(content),
          workingDirectory,
          agentSession: null,
          findingsMarkdown: null,
          messages: [userMessage, assistantMessage],
          createdAt: now,
          updatedAt: now,
        };

    setActiveExploration(exploration);
    setDraft('');
    setError(null);
    setActiveRequestId(requestId);
    try {
      await window.explorations.save(exploration);
      window.claude.start({
        requestId,
        explorationId: exploration.id,
        prompt: content,
        cwd: workingDirectory,
        ...(exploration.agentSession?.provider === 'claude'
          ? { sessionId: exploration.agentSession.externalId }
          : {}),
      });
    } catch {
      setActiveRequestId(null);
      setActiveExploration((current) =>
        current
          ? updateAssistant(current, requestId, (message) => ({
              ...message,
              status: 'error',
            }))
          : current,
      );
      setError('This exploration could not be saved.');
    }
  }

  async function persistCurrentExploration() {
    if (activeExploration) {
      await window.explorations.save(activeExploration);
    }
  }

  async function chooseWorkingDirectory() {
    try {
      const directory = await window.claude.pickDirectory();

      if (directory && directory !== workingDirectory) {
        await persistCurrentExploration();
        setWorkingDirectory(directory);
        setActiveExploration(null);
        setDraft('');
        setError(null);
      }
    } catch {
      setError('A working directory could not be selected.');
    }
  }

  async function selectExploration(id: string) {
    if (activeRequestId || id === activeExploration?.id) {
      return;
    }

    try {
      await persistCurrentExploration();
      const exploration = await window.explorations.get(id);

      if (exploration) {
        const restored = restoreInterruptedMessages(exploration);
        setActiveExploration(restored);
        setWorkingDirectory(restored.workingDirectory);
        setDraft('');
        setError(null);
      }
    } catch {
      setError('This exploration could not be loaded.');
    }
  }

  async function startNewExploration() {
    if (activeRequestId) {
      return;
    }

    try {
      await persistCurrentExploration();
      setActiveExploration(null);
      setDraft('');
      setError(null);
    } catch {
      setError('This exploration could not be saved.');
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
    <main
      className={`app-shell${isSidebarCollapsed ? ' app-shell--sidebar-collapsed' : ''}`}
    >
      <aside
        className="exploration-sidebar"
        id="exploration-sidebar"
        aria-label="Explorations"
      >
        <div className="exploration-sidebar__header">
          {!isSidebarCollapsed && <span>Explorations</span>}
          <div className="exploration-sidebar__actions">
            {!isSidebarCollapsed && (
              <Button
                type="button"
                size="icon-sm"
                disabled={activeRequestId !== null}
                aria-label="New exploration"
                title="New exploration"
                onClick={startNewExploration}
              >
                <img
                  className="exploration-sidebar__new-icon"
                  src={plusIcon}
                  alt=""
                  aria-hidden="true"
                />
              </Button>
            )}
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-controls="exploration-sidebar"
              aria-expanded={!isSidebarCollapsed}
              aria-label={`${isSidebarCollapsed ? 'Expand' : 'Collapse'} explorations sidebar`}
              title={`${isSidebarCollapsed ? 'Expand' : 'Collapse'} explorations sidebar`}
              onClick={() => setIsSidebarCollapsed((collapsed) => !collapsed)}
            >
              <img
                className={`exploration-sidebar__toggle-icon${isSidebarCollapsed ? ' exploration-sidebar__toggle-icon--expand' : ''}`}
                src={sidebarCollapseIcon}
                alt=""
                aria-hidden="true"
              />
            </Button>
          </div>
        </div>
        {!isSidebarCollapsed && (
          <nav className="exploration-list">
            {explorations.length === 0 ? (
              <p className="exploration-list__empty">No explorations yet</p>
            ) : (
              explorations.map((exploration) => (
                <Button
                  className="exploration-list__item"
                  type="button"
                  variant="ghost"
                  key={exploration.id}
                  disabled={activeRequestId !== null}
                  aria-current={
                    exploration.id === activeExploration?.id
                      ? 'page'
                      : undefined
                  }
                  title={exploration.title}
                  onClick={() => selectExploration(exploration.id)}
                >
                  {exploration.title}
                </Button>
              ))
            )}
          </nav>
        )}
      </aside>

      <ResizablePanelGroup
        className="workspace"
        defaultLayout={workspaceLayout.defaultLayout}
        id="rba.exploration-workspace"
        onLayoutChanged={workspaceLayout.onLayoutChanged}
        orientation="horizontal"
      >
        <ResizablePanel defaultSize={55} id="findings" minSize={30}>
          <aside className="findings" aria-label="Exploration findings">
            <header className="findings__header">
              <h2>Findings</h2>
            </header>
            <div
              className={`findings__content${activeExploration?.findingsMarkdown ? '' : ' findings__content--empty'}`}
              aria-live="polite"
            >
              {activeExploration?.findingsMarkdown ? (
                <MarkdownContent className="typeset-findings">
                  {activeExploration.findingsMarkdown}
                </MarkdownContent>
              ) : (
                <div className="findings-empty">
                  <img
                    className="findings-empty__graphic"
                    src={findingsEmptyIcon}
                    alt=""
                    aria-hidden="true"
                  />
                  <div className="findings-empty__copy">
                    <h3>Findings will take shape here</h3>
                    <p>
                      As you explore, key insights and decisions will be
                      gathered into a clear, evolving summary.
                    </p>
                  </div>
                </div>
              )}
            </div>
          </aside>
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel defaultSize={45} id="chat" minSize={30}>
          <section className="chat">
            <header className="chat__header">
              <h1>{activeExploration?.title ?? 'RBA'}</h1>
              <span>Sonnet</span>
            </header>

            <section className="messages" aria-live="polite">
              {messages.length === 0 ? (
                <div className="empty-state">
                  <h2>What would you like to explore?</h2>
                  <p>Describe a feature, problem, or idea to begin.</p>
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
                        {message.role === 'user' ? 'You' : 'RBA'}
                      </div>
                      {message.parts.length > 0 ? (
                        message.parts.map((part) => {
                          if (part.type === 'text') {
                            if (message.role === 'assistant') {
                              return (
                                <MarkdownContent
                                  className="message__part message__content"
                                  key={part.id}
                                >
                                  {part.text}
                                </MarkdownContent>
                              );
                            }

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
                                <code className="tool-use__detail">
                                  {detail}
                                </code>
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
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  disabled={activeRequestId !== null}
                  onClick={chooseWorkingDirectory}
                >
                  Choose folder
                </Button>
              </div>
              <form className="composer" onSubmit={submitMessage}>
                <Textarea
                  className="composer__input"
                  aria-label="Message RBA"
                  disabled={activeRequestId !== null}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={handleComposerKeyDown}
                  placeholder="Message RBA"
                  rows={3}
                  value={draft}
                />
                {activeRequestId && (
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={cancelResponse}
                  >
                    Stop
                  </Button>
                )}
              </form>
              <p className="composer-hint">
                Enter to send · Shift+Enter for a new line
              </p>
            </footer>
          </section>
        </ResizablePanel>
      </ResizablePanelGroup>
    </main>
  );
}
