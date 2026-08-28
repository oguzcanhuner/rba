import type { GoalSummary } from '../claude';
import type { ContextMenuEntry } from '../components/ui/context-menu';

type GoalContextMenuOptions = {
  goal: GoalSummary;
  onRename: () => void;
  onComplete: () => void;
  onReopen: () => void;
  onDelete: () => void;
};

/** Builds the right-click menu for a sidebar goal item. */
export function goalContextMenuItems({
  goal,
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
    label: 'Delete',
    variant: 'destructive',
    onSelect: onDelete,
  });

  return items;
}
