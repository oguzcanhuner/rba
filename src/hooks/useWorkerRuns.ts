import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useState,
} from 'react';
import type { SidebarTask, TaskStatus, WorkerRun } from '../claude';

type WorkerRunsOptions = {
  setTaskStatus: (taskId: string, status: TaskStatus) => void;
  setError: Dispatch<SetStateAction<string | null>>;
};

/**
 * Owns the task the user has opened and the worker running against it,
 * including the diff of the worktree it is editing.
 */
export function useWorkerRuns({ setTaskStatus, setError }: WorkerRunsOptions) {
  const [activeTask, setActiveTask] = useState<SidebarTask | null>(null);
  const [activeWorker, setActiveWorker] = useState<WorkerRun | null>(null);
  const [diff, setDiff] = useState('');
  const [startingTaskId, setStartingTaskId] = useState<string | null>(null);

  useEffect(
    () =>
      window.workers.onEvent((event) => {
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
      }),
    [setTaskStatus],
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
      } catch {
        setError('This task could not be marked as merged.');
      }
    },
    [setTaskStatus, setError],
  );

  const stop = useCallback(async () => {
    if (activeWorker?.status !== 'working') {
      return;
    }

    try {
      setActiveWorker(await window.workers.stop(activeWorker.taskId));
    } catch {
      setError('This worker could not be stopped.');
    }
  }, [activeWorker, setError]);

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

  return {
    activeTask,
    activeWorker,
    diff,
    startingTaskId,
    close,
    open,
    start,
    startInline,
    complete,
    stop,
    send,
  };
}
