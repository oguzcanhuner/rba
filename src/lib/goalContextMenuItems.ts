import type { GoalSummary } from '../claude';
import type { ContextMenuEntry } from '../components/ui/context-menu';

type GoalContextMenuOptions = {
  goal: GoalSummary;
  hasStartedTasks: boolean;
  onRename: () => void;
  onComplete: () => void;
  onReopen: () => void;
  onDelete: () => void;
};

/** Builds the right-click menu for a sidebar goal item. */
export function goalContextMenuItems({
  goal,
  hasStartedTasks,
  onRename,
  onComplete,
  onReopen,
  onDelete,
}: GoalContextMenuOptions): ContextMenuEntry[] {
  const items: ContextMenuEntry[] = [{ label: 'Rename', onSelect: onRename }];

  items.push(
    goal.completed
      ? { label: 'Reopen', onSelect: onReopen }
      : { label: 'Mark as complete', onSelect: onComplete },
  );

  items.push('divider');
  items.push({
    label: hasStartedTasks ? 'Delete (has started tasks)' : 'Delete',
    variant: 'destructive',
    disabled: hasStartedTasks,
    onSelect: onDelete,
  });

  return items;
}
