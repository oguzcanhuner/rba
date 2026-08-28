import type { Task } from '../claude';
import type { ContextMenuEntry } from '../components/ui/context-menu';

type TaskContextMenuOptions<T extends Task> = {
  task: T;
  isStarting: boolean;
  onOpenTask: (task: T) => void;
  onStartTask?: (task: T) => void;
  onCompleteTask?: (task: T) => void;
  onSelectGoal?: () => void;
  onDeleteTask?: (task: T) => void;
};

/** Builds the status-driven right-click menu shared by the sidebar's task
 * list and the goal's own task panel. */
export function taskContextMenuItems<T extends Task>({
  task,
  isStarting,
  onOpenTask,
  onStartTask,
  onCompleteTask,
  onSelectGoal,
  onDeleteTask,
}: TaskContextMenuOptions<T>): ContextMenuEntry[] {
  const items: ContextMenuEntry[] = [];

  if (task.status === 'queued' && onStartTask) {
    items.push({
      label: isStarting ? 'Starting…' : 'Start task',
      disabled: isStarting,
      onSelect: () => onStartTask(task),
    });
  }

  items.push({ label: 'Open task', onSelect: () => onOpenTask(task) });

  if (onSelectGoal) {
    items.push({ label: 'Go to goal', onSelect: onSelectGoal });
  }

  if (
    onCompleteTask &&
    (task.status === 'completed' ||
      task.status === 'stopped' ||
      task.status === 'failed')
  ) {
    items.push('divider');
    items.push({
      label: 'Mark as merged',
      onSelect: () => onCompleteTask(task),
    });
  }

  if (onDeleteTask) {
    items.push('divider');
    items.push({
      label: 'Delete task',
      variant: 'destructive',
      onSelect: () => onDeleteTask(task),
    });
  }

  return items;
}
