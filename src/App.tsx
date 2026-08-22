import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { useDefaultLayout } from 'react-resizable-panels';
import type {
  DisplayMessage,
  Goal,
  GoalSummary,
  GoalWithTasks,
  Task,
} from './claude';
import { ChatPanel } from './components/ChatPanel';
import { FindingsPanel } from './components/FindingsPanel';
import { GoalSidebar } from './components/GoalSidebar';
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from './components/ui/resizable';
import { WorkflowScreen } from './components/WorkflowScreen';
import { useGoalStream } from './hooks/useGoalStream';
import { useTasks } from './hooks/useTasks';
import { useWorkflowRuns } from './hooks/useWorkflowRuns';
import {
  byNewestCreation,
  goalTitle,
  restoreInterruptedMessages,
  summaryOf,
  updateAssistant,
} from './lib/goalState';

export function App() {
  const workspaceLayout = useDefaultLayout({
    id: 'rba.goal-workspace',
    panelIds: ['findings', 'chat'],
    storage: window.localStorage,
  });
  const [goals, setGoals] = useState<GoalSummary[]>([]);
  const [activeGoal, setActiveGoal] = useState<Goal | null>(null);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [draft, setDraft] = useState('');
  const [workingDirectory, setWorkingDirectory] = useState<string | null>(null);
  const [activeRequestId, setActiveRequestId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const messages = activeGoal?.messages ?? [];

  const tasks = useTasks(activeGoal?.id ?? null);
  const { replaceAll: replaceAllTasks, replaceGoalTasks } = tasks;

  const openGoal = useCallback(
    (loaded: GoalWithTasks) => {
      const { tasks: goalTasks, ...goal } = loaded;
      const restored = restoreInterruptedMessages(goal);
      setActiveGoal(restored);
      replaceGoalTasks(restored.id, restored.title, goalTasks);
      return restored;
    },
    [replaceGoalTasks],
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
            auditArtifacts: [],
            planMarkdown: null,
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
    activeGoalId: activeGoal?.id ?? null,
    activeGoalTitle: activeGoal?.title ?? null,
    replaceGoalTasks,
    startRequest: startGoalRequest,
  });

  const {
    activeTask,
    activeRun,
    definitions: workflowDefinitions,
    diff: workflowDiff,
    startingTaskId,
    close: closeWorkflow,
    open: openTask,
    start: startWorkflow,
    stop: stopWorkflow,
    resolve: resolveWorkflow,
  } = useWorkflowRuns({ setTaskStatus: tasks.setStatus, setError });

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
        closeWorkflow();
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
        const restored = openGoal(goal);
        setWorkingDirectory(restored.workingDirectory);
        closeWorkflow();
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
      closeWorkflow();
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
      applyTasksUpdate(await window.goals.commitTasks(activeGoal.id));
      setActiveGoal((current) =>
        current ? { ...current, updatedAt: new Date().toISOString() } : current,
      );
    } catch {
      setError('Tasks could not be queued.');
    }
  }

  function updatePlan(planMarkdown: string) {
    setActiveGoal((current) =>
      current
        ? {
            ...current,
            planMarkdown,
            updatedAt: new Date().toISOString(),
          }
        : current,
    );
  }

  async function reviewPlan() {
    if (
      !activeGoal?.planMarkdown?.trim() ||
      !workingDirectory ||
      activeRequestId
    ) {
      return;
    }

    setError(null);
    try {
      await window.goals.save(activeGoal);
      startGoalRequest('Review my plan.', workingDirectory);
    } catch {
      setError('The plan could not be saved for review.');
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
          tasks={tasks.committed}
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
        <WorkflowScreen
          task={activeTask}
          run={activeRun}
          definitions={workflowDefinitions}
          diff={workflowDiff}
          error={error}
          isStarting={startingTaskId === activeTask.id}
          onBack={() => {
            closeWorkflow();
            setError(null);
          }}
          onStart={(sourcePath) => startWorkflow(activeTask, sourcePath)}
          onResolve={resolveWorkflow}
          onStop={stopWorkflow}
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
              tasks={tasks.forActiveGoal}
              commitDisabled={
                activeRequestId !== null || startingTaskId !== null
              }
              onCommit={commitTasks}
              onOpenTask={openTask}
              onPlanChange={updatePlan}
              onReviewPlan={reviewPlan}
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
              isBusy={activeRequestId !== null}
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
