import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useState,
} from 'react';
import type {
  SidebarTask,
  TaskStatus,
  WorkflowDefinition,
  WorkflowRun,
} from '../claude';

type Options = {
  setTaskStatus: (taskId: string, status: TaskStatus) => void;
  setError: Dispatch<SetStateAction<string | null>>;
};

function taskStatus(status: WorkflowRun['status']): TaskStatus {
  if (status === 'running' || status === 'waiting') return 'working';
  return status;
}

export function useWorkflowRuns({ setTaskStatus, setError }: Options) {
  const [activeTask, setActiveTask] = useState<SidebarTask | null>(null);
  const [activeRun, setActiveRun] = useState<WorkflowRun | null>(null);
  const [definitions, setDefinitions] = useState<WorkflowDefinition[]>([]);
  const [diff, setDiff] = useState('');
  const [startingTaskId, setStartingTaskId] = useState<string | null>(null);

  useEffect(
    () =>
      window.workflows.onEvent(({ run }) => {
        const status = taskStatus(run.status);
        setTaskStatus(run.taskId, status);
        setActiveRun((current) => (current?.id === run.id ? run : current));
        setActiveTask((current) =>
          current?.id === run.taskId ? { ...current, status } : current,
        );
      }),
    [setTaskStatus],
  );

  useEffect(() => {
    if (!activeRun) {
      setDiff('');
      return;
    }
    let disposed = false;
    const timeout = window.setTimeout(() => {
      window.workflows
        .diff(activeRun.taskId)
        .then(({ patch }) => {
          if (!disposed) setDiff(patch);
        })
        .catch(() => {});
    }, 150);
    return () => {
      disposed = true;
      window.clearTimeout(timeout);
    };
  }, [activeRun]);

  const close = useCallback(() => {
    setActiveTask(null);
    setActiveRun(null);
    setDefinitions([]);
  }, []);

  const open = useCallback(
    async (task: SidebarTask) => {
      setError(null);
      setActiveTask(task);
      try {
        const [run, available] = await Promise.all([
          window.workflows.get(task.id),
          window.workflows.list(task.id),
        ]);
        setActiveRun(run);
        setDefinitions(available);
      } catch {
        setError('This task workflow could not be loaded.');
      }
    },
    [setError],
  );

  const start = useCallback(
    async (task: SidebarTask, sourcePath: string) => {
      setStartingTaskId(task.id);
      setError(null);
      try {
        const run = await window.workflows.start(task.id, sourcePath);
        setTaskStatus(task.id, taskStatus(run.status));
        setActiveTask({ ...task, status: taskStatus(run.status) });
        setActiveRun(run);
      } catch {
        setError(
          'This workflow could not be started. Check the workflow and repository.',
        );
      } finally {
        setStartingTaskId(null);
      }
    },
    [setError, setTaskStatus],
  );

  const resolve = useCallback(
    async (key: string, value: unknown) => {
      if (!activeRun) return;
      try {
        setActiveRun(await window.workflows.resolve(activeRun.id, key, value));
      } catch {
        setError('The workflow input could not be submitted.');
      }
    },
    [activeRun, setError],
  );

  const stop = useCallback(async () => {
    if (!activeRun) return;
    try {
      setActiveRun(await window.workflows.stop(activeRun.id));
    } catch {
      setError('This workflow could not be stopped.');
    }
  }, [activeRun, setError]);

  return {
    activeTask,
    activeRun,
    definitions,
    diff,
    startingTaskId,
    close,
    open,
    start,
    resolve,
    stop,
  };
}
