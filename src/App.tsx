import {
  type FormEvent,
  type KeyboardEvent,
  useCallback,
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
  SidebarTask,
  Task,
  ToolStatus,
  WorkerRun,
} from './claude';
import { MarkdownContent } from './components/MarkdownContent';
import { TaskList } from './components/TaskList';
import { Button } from './components/ui/button';
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from './components/ui/resizable';
import { Textarea } from './components/ui/textarea';
import { WorkerScreen } from './components/WorkerScreen';

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
      : tool.name === 'Grep'
        ? 'search files'
        : tool.name === 'Bash'
          ? 'run command'
          : tool.name === 'WebSearch'
            ? 'search the web'
            : tool.name === 'WebFetch'
              ? 'fetch page'
              : tool.name === 'mcp__rba__update_findings'
                ? 'update findings'
                : tool.name === 'mcp__rba__read_findings'
                  ? 'read findings'
                  : tool.name === 'mcp__rba__read_tasks'
                    ? 'read tasks'
                    : tool.name === 'mcp__rba__add_task'
                      ? 'draft task'
                      : tool.name === 'mcp__rba__update_task'
                        ? 'update task'
                        : tool.name === 'mcp__rba__remove_task'
                          ? 'remove task'
                          : tool.name === 'mcp__rba__commit_tasks'
                            ? 'queue tasks'
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

  if (tool.name === 'Grep') {
    return 'Searched files';
  }

  if (tool.name === 'Bash') {
    return 'Ran command';
  }

  if (tool.name === 'WebSearch') {
    return 'Searched the web';
  }

  if (tool.name === 'WebFetch') {
    return 'Fetched page';
  }

  if (tool.name === 'mcp__rba__update_findings') {
    return 'Updated findings';
  }

  const taskLabels: Record<string, string> = {
    mcp__rba__read_tasks: 'Read tasks',
    mcp__rba__add_task: 'Drafted task',
    mcp__rba__update_task: 'Updated task',
    mcp__rba__remove_task: 'Removed task',
    mcp__rba__commit_tasks: 'Queued tasks',
  };
  if (taskLabels[tool.name]) {
    return taskLabels[tool.name];
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
  const [sidebarTasks, setSidebarTasks] = useState<SidebarTask[]>([]);
  const [activeExploration, setActiveExploration] =
    useState<Exploration | null>(null);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [draft, setDraft] = useState('');
  const [workingDirectory, setWorkingDirectory] = useState<string | null>(null);
  const [activeRequestId, setActiveRequestId] = useState<string | null>(null);
  const [queuedMessages, setQueuedMessages] = useState<
    { id: string; text: string }[]
  >([]);
  const [activeWorker, setActiveWorker] = useState<WorkerRun | null>(null);
  const [activeTask, setActiveTask] = useState<SidebarTask | null>(null);
  const [workerDiff, setWorkerDiff] = useState('');
  const [startingTaskId, setStartingTaskId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const messagesContainer = useRef<HTMLElement>(null);
  const startExplorationRequestRef = useRef<
    (content: string, cwd: string) => void
  >(() => {});
  const shouldFollowMessages = useRef(true);
  const previousExplorationId = useRef<string | null>(null);
  const messages = activeExploration?.messages ?? [];

  const refreshSidebarTasks = useCallback(async () => {
    try {
      setSidebarTasks(await window.tasks.list());
    } catch {
      setError('Tasks could not be loaded.');
    }
  }, []);

  useEffect(() => {
    let disposed = false;

    Promise.all([
      window.claude.getDefaultDirectory(),
      window.explorations.list(),
      window.tasks.list(),
    ])
      .then(async ([defaultDirectory, savedExplorations, savedTasks]) => {
        if (disposed) {
          return;
        }

        setExplorations(savedExplorations);
        setSidebarTasks(savedTasks);
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

      if (event.type === 'tasks-updated') {
        void refreshSidebarTasks();
        setActiveExploration((current) =>
          current
            ? {
                ...current,
                tasks: event.tasks,
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
        // A failed turn shouldn't silently fire every queued follow-up against
        // a broken session; surface the error and let the user decide.
        setQueuedMessages([]);
      }

      setActiveRequestId((current) =>
        current === event.requestId ? null : current,
      );
    };

    return window.claude.onEvent(handleEvent);
  }, [refreshSidebarTasks]);

  useEffect(
    () =>
      window.workers.onEvent((event) => {
        const { run } = event;
        setActiveExploration((current) =>
          current?.id === run.explorationId
            ? {
                ...current,
                tasks: current.tasks.map((task) =>
                  task.id === run.taskId
                    ? {
                        ...task,
                        status: run.status,
                        updatedAt: new Date().toISOString(),
                      }
                    : task,
                ),
              }
            : current,
        );
        setActiveWorker((current) =>
          current?.taskId === run.taskId ? run : current,
        );
        setActiveTask((current) =>
          current?.id === run.taskId
            ? { ...current, status: run.status }
            : current,
        );
        setSidebarTasks((current) =>
          current.map((task) =>
            task.id === run.taskId ? { ...task, status: run.status } : task,
          ),
        );
      }),
    [],
  );

  useEffect(() => {
    if (activeRequestId || queuedMessages.length === 0 || !workingDirectory) {
      return;
    }

    const [next, ...rest] = queuedMessages;
    setQueuedMessages(rest);
    startExplorationRequestRef.current(next.text, workingDirectory);
  }, [activeRequestId, queuedMessages, workingDirectory]);

  useEffect(() => {
    if (!activeWorker) {
      setWorkerDiff('');
      return;
    }

    let disposed = false;
    const timeout = window.setTimeout(() => {
      window.workers
        .diff(activeWorker.taskId)
        .then((diff) => {
          if (!disposed) {
            setWorkerDiff(diff.patch);
          }
        })
        .catch(() => {
          // A worker update can arrive while its worktree is still being created.
        });
    }, 150);

    return () => {
      disposed = true;
      window.clearTimeout(timeout);
    };
  }, [activeWorker]);

  useEffect(() => {
    const explorationId = activeExploration?.id ?? null;
    if (explorationId !== previousExplorationId.current) {
      previousExplorationId.current = explorationId;
      shouldFollowMessages.current = true;
    }

    const container = messagesContainer.current;
    if (messages.length > 0 && container && shouldFollowMessages.current) {
      container.scrollTop = container.scrollHeight;
    }
  }, [activeExploration?.id, messages]);

  async function startExplorationRequest(content: string, cwd: string) {
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
          workingDirectory: cwd,
          agentSession: null,
          findingsMarkdown: null,
          tasks: [],
          messages: [userMessage, assistantMessage],
          createdAt: now,
          updatedAt: now,
        };

    setActiveExploration(exploration);
    setActiveRequestId(requestId);
    try {
      await window.explorations.save(exploration);
      window.claude.start({
        requestId,
        explorationId: exploration.id,
        prompt: content,
        cwd,
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

  function submitMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const content = draft.trim();
    if (!content || !workingDirectory) {
      return;
    }

    setDraft('');
    setError(null);

    if (activeRequestId) {
      // A turn is already in flight, so hold this message and send it once the
      // agent finishes its current turn.
      setQueuedMessages((queue) => [
        ...queue,
        { id: crypto.randomUUID(), text: content },
      ]);
      return;
    }

    void startExplorationRequest(content, workingDirectory);
  }

  startExplorationRequestRef.current = (content, cwd) => {
    void startExplorationRequest(content, cwd);
  };

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
        setActiveWorker(null);
        setActiveTask(null);
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
        setActiveWorker(null);
        setActiveTask(null);
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
      setActiveWorker(null);
      setActiveTask(null);
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

  async function commitTasks() {
    if (!activeExploration || activeRequestId) {
      return;
    }

    try {
      const tasks: Task[] = await window.explorations.commitTasks(
        activeExploration.id,
      );
      setActiveExploration((current) =>
        current
          ? { ...current, tasks, updatedAt: new Date().toISOString() }
          : current,
      );
      await refreshSidebarTasks();
    } catch {
      setError('Tasks could not be queued.');
    }
  }

  async function startWorker(task: SidebarTask) {
    setStartingTaskId(task.id);
    setError(null);
    try {
      const run = await window.workers.start(task.id);
      setActiveExploration((current) =>
        current
          ? {
              ...current,
              tasks: current.tasks.map((currentTask) =>
                currentTask.id === task.id
                  ? { ...currentTask, status: run.status }
                  : currentTask,
              ),
            }
          : current,
      );
      setActiveWorker(run);
      setActiveTask({ ...task, status: run.status });
      setSidebarTasks((current) =>
        current.map((item) =>
          item.id === task.id ? { ...item, status: run.status } : item,
        ),
      );
    } catch {
      setError(
        'This task could not be started. Make sure the folder is a git repository.',
      );
    } finally {
      setStartingTaskId(null);
    }
  }

  async function openTask(task: SidebarTask) {
    setError(null);
    if (task.status === 'queued') {
      setActiveTask(task);
      setActiveWorker(null);
      return;
    }
    try {
      const run = await window.workers.get(task.id);
      if (run) {
        setActiveTask(task);
        setActiveWorker(run);
      } else {
        setError('This worker could not be loaded.');
      }
    } catch {
      setError('This worker could not be loaded.');
    }
  }

  async function stopWorker() {
    if (activeWorker?.status !== 'working') {
      return;
    }
    try {
      const run = await window.workers.stop(activeWorker.taskId);
      setActiveWorker(run);
    } catch {
      setError('This worker could not be stopped.');
    }
  }

  async function sendWorkerMessage(message: string) {
    if (!activeWorker || activeWorker.status === 'working') {
      return false;
    }
    setError(null);
    try {
      const run = await window.workers.send(activeWorker.taskId, message);
      setActiveWorker(run);
      return true;
    } catch {
      setError('This message could not be sent to the worker.');
      return false;
    }
  }

  return (
    <main
      className={
        activeTask
          ? 'worker-shell dark'
          : `app-shell${isSidebarCollapsed ? ' app-shell--sidebar-collapsed' : ''}`
      }
    >
      {!activeTask && (
        <aside
          className="exploration-sidebar"
          id="exploration-sidebar"
          aria-label="Explorations and tasks"
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
            <div className="sidebar-content">
              <nav className="exploration-list" aria-label="Explorations">
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
              <section
                className="sidebar-tasks"
                aria-labelledby="sidebar-tasks-heading"
              >
                <h2 id="sidebar-tasks-heading">Tasks</h2>
                {sidebarTasks.length === 0 ? (
                  <p className="exploration-list__empty">No queued tasks yet</p>
                ) : (
                  <div className="sidebar-task-list">
                    {sidebarTasks.map((task) => (
                      <Button
                        className="sidebar-task"
                        type="button"
                        variant="ghost"
                        key={task.id}
                        title={task.title}
                        onClick={() => openTask(task)}
                      >
                        <span className="sidebar-task__title">
                          {task.title}
                        </span>
                        <span
                          className={`sidebar-task__status task__status task__status--${task.status}`}
                        >
                          {task.status}
                        </span>
                        <span className="sidebar-task__exploration">
                          {task.explorationTitle}
                        </span>
                      </Button>
                    ))}
                  </div>
                )}
              </section>
            </div>
          )}
        </aside>
      )}

      {activeTask ? (
        <WorkerScreen
          task={activeTask}
          run={activeWorker}
          diff={workerDiff}
          error={error}
          isStarting={startingTaskId === activeTask.id}
          onBack={() => {
            setActiveTask(null);
            setActiveWorker(null);
            setError(null);
          }}
          onStart={() => startWorker(activeTask)}
          onSend={sendWorkerMessage}
          onStop={stopWorker}
        />
      ) : (
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
              <div className="findings__content" aria-live="polite">
                <div
                  className={`findings__document${activeExploration?.findingsMarkdown ? '' : ' findings__document--empty'}`}
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
                {activeExploration && (
                  <TaskList
                    tasks={activeExploration.tasks}
                    commitDisabled={
                      activeRequestId !== null || startingTaskId !== null
                    }
                    onCommit={commitTasks}
                    onOpenTask={(task) => {
                      if (activeExploration) {
                        void openTask({
                          ...task,
                          explorationId: activeExploration.id,
                          explorationTitle: activeExploration.title,
                        });
                      }
                    }}
                  />
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

              <section
                className="messages"
                aria-live="polite"
                ref={messagesContainer}
                onScroll={(event) => {
                  const container = event.currentTarget;
                  const distanceFromEnd =
                    container.scrollHeight -
                    container.scrollTop -
                    container.clientHeight;
                  shouldFollowMessages.current = distanceFromEnd <= 24;
                }}
              >
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
                        {label && (
                          <div className="message__status">{label}</div>
                        )}
                      </article>
                    );
                  })
                )}
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
                {queuedMessages.length > 0 && (
                  <ul className="composer-queue" aria-label="Queued messages">
                    {queuedMessages.map((message) => (
                      <li className="composer-queue__item" key={message.id}>
                        <span className="composer-queue__label">Queued</span>
                        <span className="composer-queue__text">
                          {message.text}
                        </span>
                        <Button
                          type="button"
                          variant="ghost"
                          size="xs"
                          aria-label="Remove queued message"
                          onClick={() =>
                            setQueuedMessages((queue) =>
                              queue.filter((item) => item.id !== message.id),
                            )
                          }
                        >
                          Remove
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
                <form className="composer" onSubmit={submitMessage}>
                  <Textarea
                    className="composer__input"
                    aria-label="Message RBA"
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={handleComposerKeyDown}
                    placeholder={activeRequestId ? 'Steer RBA…' : 'Message RBA'}
                    rows={3}
                    value={draft}
                  />
                  <div className="composer__actions">
                    <Button type="submit" disabled={!draft.trim()}>
                      {activeRequestId ? 'Queue' : 'Send'}
                    </Button>
                    {activeRequestId && (
                      <Button
                        type="button"
                        variant="secondary"
                        onClick={cancelResponse}
                      >
                        Stop
                      </Button>
                    )}
                  </div>
                </form>
                <p className="composer-hint">
                  {activeRequestId
                    ? 'Enter to queue · sends when the current turn finishes'
                    : 'Enter to send · Shift+Enter for a new line'}
                </p>
              </footer>
            </section>
          </ResizablePanel>
        </ResizablePanelGroup>
      )}
    </main>
  );
}
