import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useState,
} from 'react';
import type { ClaudeStreamEvent, Goal, Task } from '../claude';
import {
  appendText,
  finishTools,
  goalIdForRequest,
  updateAssistant,
} from '../lib/goalState';

export type QueuedMessage = { id: string; text: string };

type GoalStreamOptions = {
  busyRequests: Map<string, string>;
  clearBusy: (goalId: string, requestId: string) => void;
  workingDirectory: string | null;
  updateGoal: (goalId: string, updater: (goal: Goal) => Goal) => Goal | null;
  getGoal: (goalId: string) => Goal | null;
  persistGoal: (goal: Goal) => void;
  setError: Dispatch<SetStateAction<string | null>>;
  activeGoalId: string | null;
  replaceGoalTasks: (goalId: string, goalTitle: string, tasks: Task[]) => void;
  startRequest: (content: string, cwd: string) => void;
};

/**
 * Owns every in-flight planner turn: the stream of events that builds each
 * goal's assistant message (whether or not that goal is currently
 * displayed), and the follow-ups the user queued for the active goal.
 */
export function useGoalStream({
  busyRequests,
  clearBusy,
  workingDirectory,
  updateGoal,
  getGoal,
  persistGoal,
  setError,
  activeGoalId,
  replaceGoalTasks,
  startRequest,
}: GoalStreamOptions) {
  const [queued, setQueued] = useState<QueuedMessage[]>([]);
  const activeRequestId = activeGoalId
    ? (busyRequests.get(activeGoalId) ?? null)
    : null;

  useEffect(() => {
    const handleEvent = (event: ClaudeStreamEvent) => {
      const goalId = goalIdForRequest(busyRequests, event.requestId);
      if (!goalId) {
        // The goal this event belongs to is no longer tracked (e.g. after a
        // reload), so there is nothing left to apply it to.
        return;
      }

      if (event.type === 'artifacts-updated') {
        updateGoal(goalId, (current) => ({
          ...current,
          artifacts: event.artifacts,
          updatedAt: new Date().toISOString(),
        }));
        return;
      }

      if (event.type === 'tasks-updated') {
        const goal = getGoal(goalId);
        if (goal) {
          replaceGoalTasks(goalId, goal.title, event.tasks);
        }
        updateGoal(goalId, (current) => ({
          ...current,
          updatedAt: new Date().toISOString(),
        }));
        return;
      }

      if (event.type === 'text-delta') {
        updateGoal(goalId, (current) =>
          updateAssistant(current, event.requestId, (message) => ({
            ...message,
            parts: appendText(message.parts, event.text, event.requestId),
          })),
        );
        return;
      }

      if (event.type === 'tool-start') {
        updateGoal(goalId, (current) =>
          updateAssistant(current, event.requestId, (message) => ({
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
          })),
        );
        return;
      }

      if (event.type === 'tool-input') {
        updateGoal(goalId, (current) =>
          updateAssistant(current, event.requestId, (message) => ({
            ...message,
            parts: message.parts.map((part) =>
              part.type === 'tool' && part.tool.id === event.tool.id
                ? { ...part, tool: { ...part.tool, input: event.tool.input } }
                : part,
            ),
          })),
        );
        return;
      }

      if (event.type === 'tool-result') {
        updateGoal(goalId, (current) =>
          updateAssistant(current, event.requestId, (message) => ({
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
          })),
        );
        return;
      }

      let updated: Goal | null = null;

      if (event.type === 'complete') {
        updated = updateGoal(goalId, (current) => {
          const now = new Date().toISOString();
          const withAssistant = updateAssistant(
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
            ...withAssistant,
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
        updated = updateGoal(goalId, (current) =>
          updateAssistant(current, event.requestId, (message) => ({
            ...message,
            status: 'cancelled',
            parts: finishTools(message.parts, 'cancelled'),
          })),
        );
      } else {
        updated = updateGoal(goalId, (current) =>
          updateAssistant(current, event.requestId, (message) => ({
            ...message,
            status: 'error',
            parts: finishTools(message.parts, 'error'),
          })),
        );
        setError(event.message);
        // A failed turn shouldn't silently fire every queued follow-up against
        // a broken session; surface the error and let the user decide.
        setQueued([]);
      }

      clearBusy(goalId, event.requestId);
      if (updated) {
        // Persist on completion regardless of whether this goal is currently
        // displayed, so a finished background turn is never lost.
        persistGoal(updated);
      }
    };

    return window.claude.onEvent(handleEvent);
    // The set of in-flight goals is read inside the handler via closures over
    // fresh refs, so this subscription only needs to rebuild when the
    // callbacks it depends on change identity.
  }, [
    busyRequests,
    clearBusy,
    getGoal,
    persistGoal,
    replaceGoalTasks,
    setError,
    updateGoal,
  ]);

  useEffect(() => {
    if (activeRequestId || queued.length === 0 || !workingDirectory) {
      return;
    }

    const [next, ...rest] = queued;
    setQueued(rest);
    startRequest(next.text, workingDirectory);
  }, [activeRequestId, queued, workingDirectory, startRequest]);

  const enqueue = useCallback((text: string) => {
    setQueued((queue) => [...queue, { id: crypto.randomUUID(), text }]);
  }, []);

  const removeQueued = useCallback((id: string) => {
    setQueued((queue) => queue.filter((message) => message.id !== id));
  }, []);

  const cancel = useCallback(() => {
    if (activeRequestId && activeGoalId) {
      window.claude.cancel(activeRequestId, activeGoalId);
    }
  }, [activeRequestId, activeGoalId]);

  return {
    queued,
    enqueue,
    removeQueued,
    cancel,
  };
}
