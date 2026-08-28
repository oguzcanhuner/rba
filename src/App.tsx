import {
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useDefaultLayout } from 'react-resizable-panels';
import type {
  DisplayMessage,
  Goal,
  GoalSummary,
  GoalWithTasks,
  SidebarTask,
  Task,
} from './claude';
import { ChatPanel } from './components/ChatPanel';
import { GoalSidebar } from './components/GoalSidebar';
import { PlanningPanel } from './components/PlanningPanel';
import { SettingsScreen } from './components/SettingsScreen';
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from './components/ui/resizable';
import { WorkerScreen } from './components/WorkerScreen';
import { useGoalStream } from './hooks/useGoalStream';
import { useTasks } from './hooks/useTasks';
import { useWorkerRuns } from './hooks/useWorkerRuns';
import {
  byGoalOrder,
  goalTitle,
  restoreInterruptedMessages,
  summaryOf,
  updateAssistant,
} from './lib/goalState';

export function App() {
  const workspaceLayout = useDefaultLayout({
    id: 'rba.goal-workspace',
    panelIds: ['planning', 'chat'],
    storage: window.localStorage,
  });
  const [goals, setGoals] = useState<GoalSummary[]>([]);
  // Goals currently loaded in memory: the displayed goal plus any goals
  // streaming in the background. Mirrored in a ref so stream event handlers
  // always read the latest value synchronously, unaffected by React batching.
  const [goalsCache, setGoalsCache] = useState<Map<string, Goal>>(new Map());
  const goalsCacheRef = useRef<Map<string, Goal>>(goalsCache);
  const [activeGoalId, setActiveGoalId] = useState<string | null>(null);
  // Per-goal in-flight turn: goalId -> requestId.
  const [busyRequests, setBusyRequests] = useState<Map<string, string>>(
    new Map(),
  );
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [workingDirectory, setWorkingDirectory] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const activeGoal = useMemo(
    () => (activeGoalId ? (goalsCache.get(activeGoalId) ?? null) : null),
    [activeGoalId, goalsCache],
  );
  const activeRequestId = activeGoalId
    ? (busyRequests.get(activeGoalId) ?? null)
    : null;
  const busyGoalIds = useMemo(
    () => new Set(busyRequests.keys()),
    [busyRequests],
  );
  const messages = activeGoal?.messages ?? [];

  const tasks = useTasks(activeGoal?.id ?? null);
  const { replaceAll: replaceAllTasks, replaceGoalTasks } = tasks;

  const getGoal = useCallback(
    (goalId: string) => goalsCacheRef.current.get(goalId) ?? null,
    [],
  );

  const putGoal = useCallback((goal: Goal) => {
    const next = new Map(goalsCacheRef.current);
    next.set(goal.id, goal);
    goalsCacheRef.current = next;
    setGoalsCache(next);
  }, []);

  const updateGoal = useCallback(
    (goalId: string, updater: (goal: Goal) => Goal) => {
      const existing = goalsCacheRef.current.get(goalId);
      if (!existing) {
        return null;
      }

      const updated = updater(existing);
      const next = new Map(goalsCacheRef.current);
      next.set(goalId, updated);
      goalsCacheRef.current = next;
      setGoalsCache(next);
      return updated;
    },
    [],
  );

  const persistGoal = useCallback((goal: Goal) => {
    window.goals
      .save(goal)
      .then(() => {
        const summary = summaryOf(goal);
        setGoals((current) =>
          [summary, ...current.filter((item) => item.id !== summary.id)].sort(
            byGoalOrder,
          ),
        );
      })
      .catch(() => {
        setError('This goal could not be saved.');
      });
  }, []);

  const clearBusy = useCallback((goalId: string, requestId: string) => {
    setBusyRequests((current) => {
      if (current.get(goalId) !== requestId) {
        return current;
      }
      const next = new Map(current);
      next.delete(goalId);
      return next;
    });
  }, []);

  const openGoal = useCallback(
    (loaded: GoalWithTasks) => {
      const { tasks: goalTasks, ...goal } = loaded;
      const restored = restoreInterruptedMessages(goal);
      putGoal(restored);
      setActiveGoalId(restored.id);
      replaceGoalTasks(restored.id, restored.title, goalTasks);
      return restored;
    },
    [putGoal, replaceGoalTasks],
  );

  const applyTasksUpdate = useCallback(
    (updated: Task[]) => {
      if (activeGoal) {
        replaceGoalTasks(activeGoal.id, activeGoal.title, updated);
      }
    },
    [activeGoal, replaceGoalTasks],
  );

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
      const current = activeGoalId ? getGoal(activeGoalId) : null;
      const goal: Goal = current
        ? {
            ...current,
            updatedAt: now,
            messages: [...current.messages, userMessage, assistantMessage],
          }
        : {
            id: crypto.randomUUID(),
            title: goalTitle(content),
            workingDirectory: cwd,
            agentSession: null,
            artifacts: [],
            messages: [userMessage, assistantMessage],
            createdAt: now,
            updatedAt: now,
            unread: false,
            completed: false,
          };

      putGoal(goal);
      setActiveGoalId(goal.id);
      setBusyRequests((requests) => new Map(requests).set(goal.id, requestId));
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
          clearBusy(goal.id, requestId);
          updateGoal(goal.id, (g) =>
            updateAssistant(g, requestId, (message) => ({
              ...message,
              status: 'error',
            })),
          );
          setError('This goal could not be saved.');
        });
    },
    [activeGoalId, getGoal, putGoal, updateGoal, clearBusy],
  );

  const {
    queued: queuedMessages,
    enqueue,
    removeQueued,
    cancel: cancelResponse,
  } = useGoalStream({
    busyRequests,
    clearBusy,
    workingDirectory,
    updateGoal,
    getGoal,
    persistGoal,
    setError,
    activeGoalId,
    replaceGoalTasks,
    startRequest: startGoalRequest,
  });

  const {
    activeTask,
    activeWorker,
    diff: workerDiff,
    startingTaskId,
    queued: queuedWorkerMessages,
    close: closeWorker,
    open: openTask,
    start: startTaskInBackground,
    startInline: startWorker,
    complete: completeTask,
    stop: stopWorker,
    send: sendWorkerMessage,
    enqueue: enqueueWorkerMessage,
    removeQueued: removeQueuedWorkerMessage,
  } = useWorkerRuns({
    setTaskStatus: tasks.setStatus,
    setError,
    onTaskDeleted: tasks.remove,
  });
  const [workerDraft, setWorkerDraft] = useState('');

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
        // Seed the whole cache before the goal load narrows it, so the goal's
        // own drafts are not wiped by a list that arrives late.
        replaceAllTasks(savedTasks);
        const latest = savedGoals[0];

        if (latest) {
          const saved = await window.goals.get(latest.id);
          if (!disposed && saved) {
            const restored = openGoal(saved);
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
  }, [replaceAllTasks, openGoal]);

  useEffect(() => {
    if (!activeGoal) {
      return;
    }

    const timeout = window.setTimeout(() => {
      persistGoal(activeGoal);
    }, 150);

    return () => window.clearTimeout(timeout);
  }, [activeGoal, persistGoal]);

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
        setActiveGoalId(null);
        closeWorker();
        setWorkerDraft('');
        setDraft('');
        setError(null);
      }
    } catch {
      setError('A working directory could not be selected.');
    }
  }

  function markGoalRead(id: string) {
    window.goals.markRead(id).catch(() => {});
    setGoals((current) =>
      current.map((item) =>
        item.id === id ? { ...item, unread: false } : item,
      ),
    );
  }

  async function renameGoal(id: string, title: string) {
    try {
      await window.goals.rename(id, title);
      setGoals((current) =>
        current
          .map((item) => (item.id === id ? { ...item, title } : item))
          .sort(byGoalOrder),
      );
      updateGoal(id, (goal) => ({ ...goal, title }));
    } catch {
      setError('This goal could not be renamed.');
    }
  }

  async function completeGoal(id: string) {
    try {
      await window.goals.complete(id);
      setGoals((current) =>
        current
          .map((item) => (item.id === id ? { ...item, completed: true } : item))
          .sort(byGoalOrder),
      );
    } catch {
      setError('This goal could not be marked as complete.');
    }
  }

  async function reopenGoal(id: string) {
    try {
      await window.goals.reopen(id);
      setGoals((current) =>
        current
          .map((item) =>
            item.id === id ? { ...item, completed: false } : item,
          )
          .sort(byGoalOrder),
      );
    } catch {
      setError('This goal could not be reopened.');
    }
  }

  async function deleteGoal(id: string) {
    try {
      await window.goals.delete(id);
      setGoals((current) => current.filter((item) => item.id !== id));
      replaceGoalTasks(id, '', []);
      if (id === activeGoalId) {
        setActiveGoalId(null);
        closeWorker();
        setWorkerDraft('');
        setDraft('');
      }
    } catch {
      setError('This goal could not be deleted.');
    }
  }

  async function deleteTask(id: string) {
    try {
      const result = await window.tasks.delete(id);
      if (!result.deleted) {
        return;
      }
      tasks.remove(id);
      if (id === activeTask?.id) {
        closeWorker();
      }
    } catch {
      setError('This task could not be deleted.');
    }
  }

  async function selectGoal(id: string) {
    if (id === activeGoalId) {
      return;
    }

    await persistCurrentGoal();

    // A goal that is already loaded (e.g. streaming in the background) keeps
    // its in-memory state rather than being reloaded from disk, which would
    // otherwise clobber it with the last-saved snapshot.
    const cached = getGoal(id);
    if (cached) {
      setActiveGoalId(id);
      setWorkingDirectory(cached.workingDirectory);
      closeWorker();
      setWorkerDraft('');
      setDraft('');
      setError(null);
      markGoalRead(id);
      return;
    }

    try {
      const goal = await window.goals.get(id);

      if (goal) {
        const restored = openGoal(goal);
        setWorkingDirectory(restored.workingDirectory);
        closeWorker();
        setWorkerDraft('');
        setDraft('');
        setError(null);
        markGoalRead(id);
      }
    } catch {
      setError('This goal could not be loaded.');
    }
  }

  async function startNewGoal() {
    try {
      await persistCurrentGoal();
      setActiveGoalId(null);
      closeWorker();
      setWorkerDraft('');
      setDraft('');
      setError(null);
    } catch {
      setError('This goal could not be saved.');
    }
  }

  function openWorkerTask(task: SidebarTask) {
    setWorkerDraft('');
    openTask(task);
  }

  async function submitWorkerMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const content = workerDraft.trim();
    if (!content || !activeWorker?.sessionId) {
      return;
    }

    if (activeWorker.status === 'working') {
      // Queueing can't fail, so the draft is cleared immediately rather than
      // waiting on a round trip.
      setWorkerDraft('');
      enqueueWorkerMessage(content);
      return;
    }

    const sent = await sendWorkerMessage(content);
    if (sent) {
      setWorkerDraft('');
    }
  }

  async function commitTasks() {
    if (!activeGoal || activeRequestId) {
      return;
    }

    try {
      applyTasksUpdate(await window.goals.commitTasks(activeGoal.id));
      updateGoal(activeGoal.id, (current) => ({
        ...current,
        updatedAt: new Date().toISOString(),
      }));
    } catch {
      setError('Tasks could not be queued.');
    }
  }

  return (
    <main
      className={
        isSettingsOpen
          ? ''
          : `app-shell${isSidebarCollapsed ? ' app-shell--sidebar-collapsed' : ''}`
      }
    >
      {!isSettingsOpen && (
        <GoalSidebar
          goals={goals}
          tasks={tasks.committed}
          activeGoalId={activeGoal?.id ?? null}
          activeTaskId={activeTask?.id ?? null}
          isCollapsed={isSidebarCollapsed}
          busyGoalIds={busyGoalIds}
          startingTaskId={startingTaskId}
          onToggleCollapse={() =>
            setIsSidebarCollapsed((collapsed) => !collapsed)
          }
          onNewGoal={startNewGoal}
          onSelectGoal={selectGoal}
          onRenameGoal={renameGoal}
          onCompleteGoal={completeGoal}
          onReopenGoal={reopenGoal}
          onDeleteGoal={deleteGoal}
          onOpenTask={openWorkerTask}
          onStartTask={startTaskInBackground}
          onCompleteTask={completeTask}
          onDeleteTask={(task) => deleteTask(task.id)}
          onOpenSettings={() => setIsSettingsOpen(true)}
        />
      )}

      {isSettingsOpen ? (
        <SettingsScreen onBack={() => setIsSettingsOpen(false)} />
      ) : activeTask ? (
        <WorkerScreen
          task={activeTask}
          run={activeWorker}
          diff={workerDiff}
          draft={workerDraft}
          queued={queuedWorkerMessages}
          error={error}
          isStarting={startingTaskId === activeTask.id}
          onBack={() => {
            closeWorker();
            setWorkerDraft('');
            setError(null);
          }}
          onDraftChange={setWorkerDraft}
          onSubmit={submitWorkerMessage}
          onRemoveQueued={removeQueuedWorkerMessage}
          onStart={() => startWorker(activeTask)}
          onStop={stopWorker}
          onComplete={() => completeTask(activeTask)}
        />
      ) : (
        <ResizablePanelGroup
          className="workspace"
          defaultLayout={workspaceLayout.defaultLayout}
          id="rba.goal-workspace"
          onLayoutChanged={workspaceLayout.onLayoutChanged}
          orientation="horizontal"
        >
          <ResizablePanel defaultSize={55} id="planning" minSize={30}>
            <PlanningPanel
              goal={activeGoal}
              tasks={tasks.forActiveGoal}
              commitDisabled={
                activeRequestId !== null || startingTaskId !== null
              }
              startingTaskId={startingTaskId}
              onCommit={commitTasks}
              onOpenTask={openWorkerTask}
              onStartTask={startTaskInBackground}
              onCompleteTask={completeTask}
              onDeleteTask={(task) => deleteTask(task.id)}
            />
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel defaultSize={45} id="chat" minSize={30}>
            <ChatPanel
              title={activeGoal?.title ?? null}
              goalId={activeGoal?.id ?? null}
              messages={messages}
              draft={draft}
              queued={queuedMessages}
              workingDirectory={workingDirectory}
              error={error}
              isActiveGoalBusy={activeRequestId !== null}
              onDraftChange={setDraft}
              onSubmit={submitMessage}
              onCancel={cancelResponse}
              onChooseDirectory={chooseWorkingDirectory}
              onRemoveQueued={removeQueued}
            />
          </ResizablePanel>
        </ResizablePanelGroup>
      )}
    </main>
  );
}
