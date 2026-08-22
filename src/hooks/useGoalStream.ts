import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useState,
} from 'react';
import type { ClaudeStreamEvent, Goal, Task } from '../claude';
import { appendText, finishTools, updateAssistant } from '../lib/goalState';

export type QueuedMessage = { id: string; text: string };

type GoalStreamOptions = {
  activeRequestId: string | null;
  setActiveRequestId: Dispatch<SetStateAction<string | null>>;
  workingDirectory: string | null;
  setActiveGoal: Dispatch<SetStateAction<Goal | null>>;
  setError: Dispatch<SetStateAction<string | null>>;
  activeGoalId: string | null;
  activeGoalTitle: string | null;
  replaceGoalTasks: (goalId: string, goalTitle: string, tasks: Task[]) => void;
  startRequest: (content: string, cwd: string) => void;
};

/**
 * Owns the in-flight planner turn: the stream of events that builds the
 * assistant message, and the follow-ups the user queued while it was running.
 */
export function useGoalStream({
  activeRequestId,
  setActiveRequestId,
  workingDirectory,
  setActiveGoal,
  setError,
  activeGoalId,
  activeGoalTitle,
  replaceGoalTasks,
  startRequest,
}: GoalStreamOptions) {
  const [queued, setQueued] = useState<QueuedMessage[]>([]);

  useEffect(() => {
    const handleEvent = (event: ClaudeStreamEvent) => {
      if (event.type === 'audit-updated') {
        setActiveGoal((current) =>
          current
            ? {
                ...current,
                auditArtifacts: event.artifacts,
                updatedAt: new Date().toISOString(),
              }
            : current,
        );
        return;
      }

      if (event.type === 'tasks-updated') {
        if (activeGoalId && activeGoalTitle) {
          replaceGoalTasks(activeGoalId, activeGoalTitle, event.tasks);
        }
        setActiveGoal((current) =>
          current
            ? { ...current, updatedAt: new Date().toISOString() }
            : current,
        );
        return;
      }

      if (event.type === 'text-delta') {
        setActiveGoal((current) =>
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
        setActiveGoal((current) =>
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
        setActiveGoal((current) =>
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
        setActiveGoal((current) =>
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
        setActiveGoal((current) => {
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
        setActiveGoal((current) =>
          current
            ? updateAssistant(current, event.requestId, (message) => ({
                ...message,
                status: 'cancelled',
                parts: finishTools(message.parts, 'cancelled'),
              }))
            : current,
        );
      } else {
        setActiveGoal((current) =>
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
        setQueued([]);
      }

      setActiveRequestId((current) =>
        current === event.requestId ? null : current,
      );
    };

    return window.claude.onEvent(handleEvent);
    // The goal identity is read inside the handler, so the subscription is
    // rebuilt when the user switches goals — not on every streamed delta.
  }, [
    activeGoalId,
    activeGoalTitle,
    replaceGoalTasks,
    setActiveGoal,
    setActiveRequestId,
    setError,
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
    if (activeRequestId) {
      window.claude.cancel(activeRequestId);
    }
  }, [activeRequestId]);

  return {
    queued,
    enqueue,
    removeQueued,
    cancel,
  };
}
