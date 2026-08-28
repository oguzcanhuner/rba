import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { SidebarTask, TaskStatus, WorkerRun } from '../claude';
import type { QueuedMessage } from './useGoalStream';

type WorkerRunsOptions = {
  setTaskStatus: (taskId: string, status: TaskStatus) => void;
  setError: Dispatch<SetStateAction<string | null>>;
};

/**
 * Owns the task the user has opened and the worker running against it,
 * including the diff of the worktree it is editing, and the follow-up
 * messages queued for background tasks the user has switched away from.
 */
export function useWorkerRuns({ setTaskStatus, setError }: WorkerRunsOptions) {
  const [activeTask, setActiveTask] = useState<SidebarTask | null>(null);
  const [activeWorker, setActiveWorker] = useState<WorkerRun | null>(null);
  const [diff, setDiff] = useState('');
  const [startingTaskId, setStartingTaskId] = useState<string | null>(null);
  // Queued follow-ups, keyed by taskId rather than a flat list: a worker
  // keeps running in the background after the user switches to another
  // task, so a flat queue would deliver a message to the wrong worker.
  const [queues, setQueues] = useState<Map<string, QueuedMessage[]>>(new Map());
  const queuesRef = useRef(queues);
  queuesRef.current = queues;

  const clearQueue = useCallback((taskId: string) => {
    setQueues((current) => {
      if (!current.has(taskId)) {
        return current;
      }
      const next = new Map(current);
      next.delete(taskId);
      return next;
    });
  }, []);

  useEffect(
    () =>
      window.workers.onEvent((event) => {
        if (event.type !== 'worker-updated') {
          return;
        }
        const { run } = event;
        setTaskStatus(run.taskId, run.status);
        setActiveWorker((current) =>
          current?.taskId === run.taskId ? run : current,
        );
        setActiveTask((current) =>
          current?.id === run.taskId && current.status !== run.status
            ? { ...current, status: run.status }
            : current,
        );

        // Drain one queued follow-up once this worker is sendable again,
        // regardless of which task is currently displayed.
        if (run.status !== 'working' && run.sessionId) {
          const pending = queuesRef.current.get(run.taskId);
          if (pending && pending.length > 0) {
            const [next, ...rest] = pending;
            setQueues((current) => {
              const nextQueues = new Map(current);
              if (rest.length === 0) {
                nextQueues.delete(run.taskId);
              } else {
                nextQueues.set(run.taskId, rest);
              }
              return nextQueues;
            });
            window.workers
              .send(run.taskId, next.text)
              .then((updated) => {
                setActiveWorker((current) =>
                  current?.taskId === updated.taskId ? updated : current,
                );
              })
              .catch(() => {
                setError('This message could not be sent to the worker.');
                // A failed send shouldn't silently fire the rest of the
                // queue against a broken worker; surface the error and let
                // the user decide.
                clearQueue(run.taskId);
              });
          }
        }
      }),
    [setTaskStatus, setError, clearQueue],
  );

  useEffect(() => {
    if (!activeWorker) {
      setDiff('');
      return;
    }

    let disposed = false;
    const timeout = window.setTimeout(() => {
      window.workers
        .diff(activeWorker.taskId)
        .then((patch) => {
          if (!disposed) {
            setDiff(patch.patch);
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

  const close = useCallback(() => {
    setActiveTask(null);
    setActiveWorker(null);
  }, []);

  const open = useCallback(
    async (task: SidebarTask) => {
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
    },
    [setError],
  );

  /** Starts a task in the background without switching into WorkerScreen.
   * Status updates arrive through the worker event listener above. */
  const start = useCallback(
    async (task: SidebarTask) => {
      setStartingTaskId(task.id);
      setError(null);
      try {
        await window.workers.start(task.id);
      } catch {
        setError(
          'This task could not be started. Make sure the folder is a git repository.',
        );
      } finally {
        setStartingTaskId(null);
      }
    },
    [setError],
  );

  /** Starts a task from within WorkerScreen, where the user is already
   * looking at it, so the run is shown inline as soon as it starts. */
  const startInline = useCallback(
    async (task: SidebarTask) => {
      setStartingTaskId(task.id);
      setError(null);
      try {
        const run = await window.workers.start(task.id);
        setTaskStatus(task.id, run.status);
        setActiveWorker(run);
        setActiveTask({ ...task, status: run.status });
      } catch {
        setError(
          'This task could not be started. Make sure the folder is a git repository.',
        );
      } finally {
        setStartingTaskId(null);
      }
    },
    [setTaskStatus, setError],
  );

  const complete = useCallback(
    async (task: SidebarTask) => {
      setError(null);
      try {
        await window.workers.complete(task.id);
        setTaskStatus(task.id, 'merged');
        setActiveTask((current) =>
          current?.id === task.id ? { ...current, status: 'merged' } : current,
        );
        clearQueue(task.id);
      } catch {
        setError('This task could not be marked as merged.');
      }
    },
    [setTaskStatus, setError, clearQueue],
  );

  const stop = useCallback(async () => {
    if (activeWorker?.status !== 'working') {
      return;
    }

    try {
      setActiveWorker(await window.workers.stop(activeWorker.taskId));
      clearQueue(activeWorker.taskId);
    } catch {
      setError('This worker could not be stopped.');
    }
  }, [activeWorker, setError, clearQueue]);

  const send = useCallback(
    async (message: string) => {
      if (!activeWorker || activeWorker.status === 'working') {
        return false;
      }

      setError(null);
      try {
        setActiveWorker(
          await window.workers.send(activeWorker.taskId, message),
        );
        return true;
      } catch {
        setError('This message could not be sent to the worker.');
        return false;
      }
    },
    [activeWorker, setError],
  );

  const enqueue = useCallback(
    (text: string) => {
      const taskId = activeTask?.id;
      if (!taskId) {
        return;
      }
      setQueues((current) => {
        const next = new Map(current);
        next.set(taskId, [
          ...(next.get(taskId) ?? []),
          { id: crypto.randomUUID(), text },
        ]);
        return next;
      });
    },
    [activeTask],
  );

  const removeQueued = useCallback(
    (id: string) => {
      const taskId = activeTask?.id;
      if (!taskId) {
        return;
      }
      setQueues((current) => {
        const list = current.get(taskId);
        if (!list) {
          return current;
        }
        const filtered = list.filter((message) => message.id !== id);
        const next = new Map(current);
        if (filtered.length === 0) {
          next.delete(taskId);
        } else {
          next.set(taskId, filtered);
        }
        return next;
      });
    },
    [activeTask],
  );

  const queued = useMemo(
    () => (activeTask ? (queues.get(activeTask.id) ?? []) : []),
    [queues, activeTask],
  );

  return {
    activeTask,
    activeWorker,
    diff,
    startingTaskId,
    queued,
    close,
    open,
    start,
    startInline,
    complete,
    stop,
    send,
    enqueue,
    removeQueued,
  };
}
