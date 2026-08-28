import { useCallback, useMemo, useState } from 'react';
import type { SidebarTask, Task, TaskStatus } from '../claude';

function index(tasks: SidebarTask[]) {
  return Object.fromEntries(tasks.map((task) => [task.id, task]));
}

/**
 * The one client-side copy of the tasks the app knows about. Both lists the UI
 * shows are views over it: the sidebar is every committed task newest first,
 * and the findings pane is the open goal's own tasks in sequence.
 */
export function useTasks(activeGoalId: string | null) {
  const [byId, setById] = useState<Record<string, SidebarTask>>({});

  const replaceAll = useCallback((tasks: SidebarTask[]) => {
    setById(index(tasks));
  }, []);

  /** Replaces everything known about one goal, so removals propagate too. */
  const replaceGoalTasks = useCallback(
    (goalId: string, goalTitle: string, tasks: Task[]) => {
      setById((current) => {
        const next = index(
          Object.values(current).filter((task) => task.goalId !== goalId),
        );
        for (const task of tasks) {
          next[task.id] = { ...task, goalId, goalTitle };
        }
        return next;
      });
    },
    [],
  );

  const remove = useCallback((taskId: string) => {
    setById((current) => {
      if (!(taskId in current)) {
        return current;
      }
      const { [taskId]: _removed, ...rest } = current;
      return rest;
    });
  }, []);

  const setStatus = useCallback((taskId: string, status: TaskStatus) => {
    setById((current) => {
      const task = current[taskId];
      if (!task || task.status === status) {
        return current;
      }

      return {
        ...current,
        [taskId]: { ...task, status, updatedAt: new Date().toISOString() },
      };
    });
  }, []);

  const committed = useMemo(
    () =>
      Object.values(byId)
        .filter((task) => task.status !== 'draft')
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
    [byId],
  );

  const forActiveGoal = useMemo(
    () =>
      Object.values(byId)
        .filter((task) => task.goalId === activeGoalId)
        .sort((left, right) => left.sequence - right.sequence),
    [byId, activeGoalId],
  );

  return {
    committed,
    forActiveGoal,
    replaceAll,
    replaceGoalTasks,
    setStatus,
    remove,
  };
}
