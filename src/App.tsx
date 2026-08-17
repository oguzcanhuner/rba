import {
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useDefaultLayout } from 'react-resizable-panels';
import type {
  DisplayMessage,
  Goal,
  GoalSummary,
  SidebarTask,
  Task,
  WorkerRun,
} from './claude';
import { Composer } from './components/Composer';
import { FindingsPanel } from './components/FindingsPanel';
import { GoalSidebar } from './components/GoalSidebar';
import { MessageThread } from './components/MessageThread';
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from './components/ui/resizable';
import { WorkerScreen } from './components/WorkerScreen';
import { useGoalStream } from './hooks/useGoalStream';
import {
  byNewestCreation,
  goalTitle,
  restoreInterruptedMessages,
  summaryOf,
  updateAssistant,
} from './lib/goalState';
import { plannerToolLabel } from './lib/toolLabels';

export function App() {
  const workspaceLayout = useDefaultLayout({
    id: 'rba.goal-workspace',
    panelIds: ['findings', 'chat'],
    storage: window.localStorage,
  });
  const [goals, setGoals] = useState<GoalSummary[]>([]);
  const [sidebarTasks, setSidebarTasks] = useState<SidebarTask[]>([]);
  const [activeGoal, setActiveGoal] = useState<Goal | null>(null);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [draft, setDraft] = useState('');
  const [workingDirectory, setWorkingDirectory] = useState<string | null>(null);
  const [activeRequestId, setActiveRequestId] = useState<string | null>(null);
  const [activeWorker, setActiveWorker] = useState<WorkerRun | null>(null);
  const [activeTask, setActiveTask] = useState<SidebarTask | null>(null);
  const [workerDiff, setWorkerDiff] = useState('');
  const [startingTaskId, setStartingTaskId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const messagesContainer = useRef<HTMLElement>(null);
  const shouldFollowMessages = useRef(true);
  const previousGoalId = useRef<string | null>(null);
  const messages = activeGoal?.messages ?? [];

  const refreshSidebarTasks = useCallback(() => {
    window.tasks
      .list()
      .then(setSidebarTasks)
      .catch(() => setError('Tasks could not be loaded.'));
  }, []);

  const startGoalRequest = useCallback(
    (content: string, cwd: string) => {
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
      const goal: Goal = activeGoal
        ? {
            ...activeGoal,
            updatedAt: now,
            messages: [...activeGoal.messages, userMessage, assistantMessage],
          }
        : {
            id: crypto.randomUUID(),
            title: goalTitle(content),
            workingDirectory: cwd,
            agentSession: null,
            findingsMarkdown: null,
            tasks: [],
            messages: [userMessage, assistantMessage],
            createdAt: now,
            updatedAt: now,
          };

      setActiveGoal(goal);
      setActiveRequestId(requestId);
      window.goals
        .save(goal)
        .then(() => {
          window.claude.start({
            requestId,
            goalId: goal.id,
            prompt: content,
            cwd,
            ...(goal.agentSession?.provider === 'claude'
              ? { sessionId: goal.agentSession.externalId }
              : {}),
          });
        })
        .catch(() => {
          setActiveRequestId(null);
          setActiveGoal((current) =>
            current
              ? updateAssistant(current, requestId, (message) => ({
                  ...message,
                  status: 'error',
                }))
              : current,
          );
          setError('This goal could not be saved.');
        });
    },
    [activeGoal],
  );

  const {
    queued: queuedMessages,
    enqueue,
    removeQueued,
    cancel: cancelResponse,
  } = useGoalStream({
    activeRequestId,
    setActiveRequestId,
    workingDirectory,
    setActiveGoal,
    setError,
    refreshSidebarTasks,
    startRequest: startGoalRequest,
  });

  useEffect(() => {
    let disposed = false;

    Promise.all([
      window.claude.getDefaultDirectory(),
      window.goals.list(),
      window.tasks.list(),
    ])
      .then(async ([defaultDirectory, savedGoals, savedTasks]) => {
        if (disposed) {
          return;
        }

        setGoals(savedGoals);
        setSidebarTasks(savedTasks);
        const latest = savedGoals[0];

        if (latest) {
          const saved = await window.goals.get(latest.id);
          if (!disposed && saved) {
            const restored = restoreInterruptedMessages(saved);
            setActiveGoal(restored);
            setWorkingDirectory(restored.workingDirectory);
          }
        } else {
          setWorkingDirectory(defaultDirectory);
        }
      })
      .catch(() => {
        if (!disposed) {
          setError('Saved goals could not be loaded.');
        }
      });

    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    if (!activeGoal) {
      return;
    }

    const timeout = window.setTimeout(() => {
      window.goals
        .save(activeGoal)
        .then(() => {
          const summary = summaryOf(activeGoal);
          setGoals((current) =>
            [summary, ...current.filter((item) => item.id !== summary.id)].sort(
              byNewestCreation,
            ),
          );
        })
        .catch(() => {
          setError('This goal could not be saved.');
        });
    }, 150);

    return () => window.clearTimeout(timeout);
  }, [activeGoal]);

  useEffect(
    () =>
      window.workers.onEvent((event) => {
        const { run } = event;
        // A worker broadcasts on every streamed delta, so only build new state
        // when the status actually moved. Otherwise each delta gives the goal a
        // fresh identity and the autosave effect rewrites the whole planner
        // conversation to disk, over and over, for the length of the run.
        setActiveGoal((current) => {
          if (
            current?.id !== run.goalId ||
            !current.tasks.some(
              (task) => task.id === run.taskId && task.status !== run.status,
            )
          ) {
            return current;
          }

          return {
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
          };
        });
        setActiveWorker((current) =>
          current?.taskId === run.taskId ? run : current,
        );
        setActiveTask((current) =>
          current?.id === run.taskId && current.status !== run.status
            ? { ...current, status: run.status }
            : current,
        );
        setSidebarTasks((current) =>
          current.some(
            (task) => task.id === run.taskId && task.status !== run.status,
          )
            ? current.map((task) =>
                task.id === run.taskId ? { ...task, status: run.status } : task,
              )
            : current,
        );
      }),
    [],
  );

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
    const goalId = activeGoal?.id ?? null;
    if (goalId !== previousGoalId.current) {
      previousGoalId.current = goalId;
      shouldFollowMessages.current = true;
    }

    const container = messagesContainer.current;
    if (messages.length > 0 && container && shouldFollowMessages.current) {
      container.scrollTop = container.scrollHeight;
    }
  }, [activeGoal?.id, messages]);

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
      enqueue(content);
      return;
    }

    startGoalRequest(content, workingDirectory);
  }

  async function persistCurrentGoal() {
    if (activeGoal) {
      await window.goals.save(activeGoal);
    }
  }

  async function chooseWorkingDirectory() {
    try {
      const directory = await window.claude.pickDirectory();

      if (directory && directory !== workingDirectory) {
        await persistCurrentGoal();
        setWorkingDirectory(directory);
        setActiveGoal(null);
        setActiveWorker(null);
        setActiveTask(null);
        setDraft('');
        setError(null);
      }
    } catch {
      setError('A working directory could not be selected.');
    }
  }

  async function selectGoal(id: string) {
    if (activeRequestId || id === activeGoal?.id) {
      return;
    }

    try {
      await persistCurrentGoal();
      const goal = await window.goals.get(id);

      if (goal) {
        const restored = restoreInterruptedMessages(goal);
        setActiveGoal(restored);
        setWorkingDirectory(restored.workingDirectory);
        setActiveWorker(null);
        setActiveTask(null);
        setDraft('');
        setError(null);
      }
    } catch {
      setError('This goal could not be loaded.');
    }
  }

  async function startNewGoal() {
    if (activeRequestId) {
      return;
    }

    try {
      await persistCurrentGoal();
      setActiveGoal(null);
      setActiveWorker(null);
      setActiveTask(null);
      setDraft('');
      setError(null);
    } catch {
      setError('This goal could not be saved.');
    }
  }

  async function commitTasks() {
    if (!activeGoal || activeRequestId) {
      return;
    }

    try {
      const tasks: Task[] = await window.goals.commitTasks(activeGoal.id);
      setActiveGoal((current) =>
        current
          ? { ...current, tasks, updatedAt: new Date().toISOString() }
          : current,
      );
      refreshSidebarTasks();
    } catch {
      setError('Tasks could not be queued.');
    }
  }

  async function startWorker(task: SidebarTask) {
    setStartingTaskId(task.id);
    setError(null);
    try {
      const run = await window.workers.start(task.id);
      setActiveGoal((current) =>
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
        <GoalSidebar
          goals={goals}
          tasks={sidebarTasks}
          activeGoalId={activeGoal?.id ?? null}
          isCollapsed={isSidebarCollapsed}
          isBusy={activeRequestId !== null}
          onToggleCollapse={() =>
            setIsSidebarCollapsed((collapsed) => !collapsed)
          }
          onNewGoal={startNewGoal}
          onSelectGoal={selectGoal}
          onOpenTask={openTask}
        />
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
          id="rba.goal-workspace"
          onLayoutChanged={workspaceLayout.onLayoutChanged}
          orientation="horizontal"
        >
          <ResizablePanel defaultSize={55} id="findings" minSize={30}>
            <FindingsPanel
              goal={activeGoal}
              commitDisabled={
                activeRequestId !== null || startingTaskId !== null
              }
              onCommit={commitTasks}
              onOpenTask={openTask}
            />
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel defaultSize={45} id="chat" minSize={30}>
            <section className="chat">
              <header className="chat__header">
                <h1>{activeGoal?.title ?? 'RBA'}</h1>
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
                    <h2>What would you like to achieve?</h2>
                    <p>Describe a feature, problem, or idea to begin.</p>
                  </div>
                ) : (
                  <MessageThread
                    assistantLabel="RBA"
                    messages={messages}
                    toolLabel={plannerToolLabel}
                  />
                )}
              </section>

              <Composer
                draft={draft}
                queued={queuedMessages}
                workingDirectory={workingDirectory}
                error={error}
                isBusy={activeRequestId !== null}
                onDraftChange={setDraft}
                onSubmit={submitMessage}
                onCancel={cancelResponse}
                onChooseDirectory={chooseWorkingDirectory}
                onRemoveQueued={removeQueued}
              />
            </section>
          </ResizablePanel>
        </ResizablePanelGroup>
      )}
    </main>
  );
}
