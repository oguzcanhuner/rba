import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useState,
} from 'react';
import type { Goal, SidebarTask, WorkerRun } from '../claude';

type WorkerRunsOptions = {
  setActiveGoal: Dispatch<SetStateAction<Goal | null>>;
  setSidebarTasks: Dispatch<SetStateAction<SidebarTask[]>>;
  setError: Dispatch<SetStateAction<string | null>>;
};

/**
 * Owns the task the user has opened and the worker running against it,
 * including the diff of the worktree it is editing.
 */
export function useWorkerRuns({
  setActiveGoal,
  setSidebarTasks,
  setError,
}: WorkerRunsOptions) {
  const [activeTask, setActiveTask] = useState<SidebarTask | null>(null);
  const [activeWorker, setActiveWorker] = useState<WorkerRun | null>(null);
  const [diff, setDiff] = useState('');
  const [startingTaskId, setStartingTaskId] = useState<string | null>(null);

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
    [setActiveGoal, setSidebarTasks],
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

  const start = useCallback(
    async (task: SidebarTask) => {
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
    },
    [setActiveGoal, setSidebarTasks, setError],
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
    stop,
    send,
  };
}
