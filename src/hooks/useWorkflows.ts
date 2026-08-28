import { useCallback, useEffect, useState } from 'react';
import type { Workflow, WorkflowRun, WorkflowSummary } from '../claude';

/**
 * Owns the list of registered workflows and whichever run the user is
 * currently looking at. A run keeps going in the main process whether or
 * not this screen is mounted, so state is reconciled on load rather than
 * assumed to be current from prior events alone.
 */
export function useWorkflows() {
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedWorkflow, setSelectedWorkflow] = useState<Workflow | null>(
    null,
  );
  const [activeRun, setActiveRun] = useState<WorkflowRun | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setWorkflows(await window.workflows.list());
    } catch {
      setError('Workflows could not be loaded.');
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(
    () =>
      window.workflows.onEvent((event) => {
        if (event.type !== 'run-updated') {
          return;
        }
        setActiveRun((current) =>
          current?.id === event.run.id ? event.run : current,
        );
        void reload();
      }),
    [reload],
  );

  const select = useCallback(
    async (id: string) => {
      setSelectedId(id);
      setError(null);
      try {
        const workflow = await window.workflows.get(id);
        setSelectedWorkflow(workflow);
        if (workflow) {
          const latest = workflows.find((item) => item.id === id)?.latestRun;
          setActiveRun(
            latest ? await window.workflows.getRun(latest.id) : null,
          );
        } else {
          setActiveRun(null);
        }
      } catch {
        setError('This workflow could not be loaded.');
      }
    },
    [workflows],
  );

  const openRun = useCallback(async (runId: string) => {
    setError(null);
    try {
      setActiveRun(await window.workflows.getRun(runId));
    } catch {
      setError('This run could not be loaded.');
    }
  }, []);

  const start = useCallback(
    async (id: string, options?: { directory?: string; fresh?: boolean }) => {
      setError(null);
      try {
        const run = await window.workflows.start(id, options);
        setActiveRun(run);
        await reload();
      } catch (startError) {
        setError(
          startError instanceof Error
            ? startError.message
            : 'This workflow could not be started.',
        );
      }
    },
    [reload],
  );

  const stop = useCallback(async () => {
    if (!activeRun) {
      return;
    }
    setError(null);
    try {
      setActiveRun(await window.workflows.stop(activeRun.id));
      await reload();
    } catch {
      setError('This run could not be stopped.');
    }
  }, [activeRun, reload]);

  const save = useCallback(
    async (request: Parameters<typeof window.workflows.save>[0]) => {
      setError(null);
      const workflow = await window.workflows.save(request);
      await reload();
      setSelectedId(workflow.id);
      setSelectedWorkflow(workflow);
      return workflow;
    },
    [reload],
  );

  const remove = useCallback(
    async (id: string) => {
      setError(null);
      try {
        await window.workflows.delete(id);
        if (selectedId === id) {
          setSelectedId(null);
          setSelectedWorkflow(null);
          setActiveRun(null);
        }
        await reload();
      } catch {
        setError('This workflow could not be deleted.');
      }
    },
    [selectedId, reload],
  );

  return {
    workflows,
    selectedId,
    selectedWorkflow,
    activeRun,
    error,
    setError,
    select,
    openRun,
    start,
    stop,
    save,
    remove,
  };
}
