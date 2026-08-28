import { Workflow } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { List, type RowComponentProps } from 'react-window';
import plusIcon from '../assets/plus.svg';
import settingsIcon from '../assets/settings.svg';
import sidebarCollapseIcon from '../assets/sidebar-collapse.svg';
import type { GoalSummary, SidebarTask } from '../claude';
import { goalContextMenuItems } from '../lib/goalContextMenuItems';
import { formatRelativeTime } from '../lib/relativeTime';
import { taskContextMenuItems } from '../lib/taskContextMenuItems';
import { TaskStatusIndicator } from './TaskStatusIndicator';
import { Button } from './ui/button';
import { ContextMenu } from './ui/context-menu';

const GOAL_ROW_HEIGHT = 36;
const TASK_ROW_HEIGHT = 52;

function taskStatusLabel(status: SidebarTask['status']) {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function countOpenTasks(tasks: SidebarTask[], goalId: string) {
  return tasks.filter(
    (task) => task.goalId === goalId && task.status !== 'merged',
  ).length;
}

function hasStartedTasks(tasks: SidebarTask[], goalId: string) {
  return tasks.some(
    (task) => task.goalId === goalId && task.status !== 'queued',
  );
}

type GoalSidebarProps = {
  goals: GoalSummary[];
  tasks: SidebarTask[];
  activeGoalId: string | null;
  activeTaskId: string | null;
  isCollapsed: boolean;
  /** Goals with a turn currently streaming, whether or not displayed. */
  busyGoalIds: Set<string>;
  startingTaskId: string | null;
  onToggleCollapse: () => void;
  onNewGoal: () => void;
  onSelectGoal: (id: string) => void;
  onRenameGoal: (id: string, title: string) => void;
  onCompleteGoal: (id: string) => void;
  onReopenGoal: (id: string) => void;
  onDeleteGoal: (id: string) => void;
  onOpenTask: (task: SidebarTask) => void;
  onStartTask: (task: SidebarTask) => void;
  onCompleteTask: (task: SidebarTask) => void;
  onOpenSettings: () => void;
  onOpenWorkflows: () => void;
};

type GoalRowProps = {
  goals: GoalSummary[];
  tasks: SidebarTask[];
  activeGoalId: string | null;
  busyGoalIds: Set<string>;
  renamingGoalId: string | null;
  renameValue: string;
  renameInputRef: React.RefObject<HTMLInputElement | null>;
  onSelectGoal: (id: string) => void;
  onStartRenaming: (goal: GoalSummary) => void;
  onRenameValueChange: (value: string) => void;
  onCommitRename: (goal: GoalSummary) => void;
  onCancelRename: () => void;
  onContextMenu: (goal: GoalSummary, x: number, y: number) => void;
};

function GoalRow({
  index,
  style,
  goals,
  tasks,
  activeGoalId,
  busyGoalIds,
  renamingGoalId,
  renameValue,
  renameInputRef,
  onSelectGoal,
  onStartRenaming,
  onRenameValueChange,
  onCommitRename,
  onCancelRename,
  onContextMenu,
}: RowComponentProps<GoalRowProps>) {
  const goal = goals[index];
  const openTaskCount = countOpenTasks(tasks, goal.id);

  if (renamingGoalId === goal.id) {
    return (
      <div className="goal-list__item goal-list__item--editing" style={style}>
        <input
          ref={renameInputRef}
          className="goal-list__rename-input"
          value={renameValue}
          onChange={(event) => onRenameValueChange(event.target.value)}
          onBlur={() => onCommitRename(goal)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.currentTarget.blur();
            } else if (event.key === 'Escape') {
              onCancelRename();
            }
          }}
        />
      </div>
    );
  }

  return (
    <Button
      className={`goal-list__item${goal.completed ? ' goal-list__item--completed' : ''}`}
      type="button"
      variant="ghost"
      style={style}
      aria-current={goal.id === activeGoalId ? 'page' : undefined}
      aria-busy={busyGoalIds.has(goal.id)}
      title={goal.title}
      onClick={() => onSelectGoal(goal.id)}
      onDoubleClick={() => onStartRenaming(goal)}
      onContextMenu={(event) => {
        event.preventDefault();
        onContextMenu(goal, event.clientX, event.clientY);
      }}
    >
      <span className="goal-list__title">{goal.title}</span>
      {openTaskCount > 0 && (
        <span className="goal-list__count">{openTaskCount}</span>
      )}
      {busyGoalIds.has(goal.id) ? (
        <span
          className="goal-list__busy-indicator"
          role="status"
          aria-label="Working"
          title="Working"
        />
      ) : (
        goal.unread && (
          <span
            className="goal-list__unread-indicator"
            role="status"
            aria-label="Unread"
            title="Unread"
          />
        )
      )}
    </Button>
  );
}

type TaskRowProps = {
  tasks: SidebarTask[];
  activeTaskId: string | null;
  onOpenTask: (task: SidebarTask) => void;
  onContextMenu: (task: SidebarTask, x: number, y: number) => void;
};

function TaskRow({
  index,
  style,
  tasks,
  activeTaskId,
  onOpenTask,
  onContextMenu,
}: RowComponentProps<TaskRowProps>) {
  const task = tasks[index];

  return (
    <Button
      className={`sidebar-task${task.status === 'merged' ? ' sidebar-task--merged' : ''}`}
      type="button"
      variant="ghost"
      style={style}
      aria-current={task.id === activeTaskId ? 'page' : undefined}
      title={task.title}
      onClick={() => {
        if (task.status !== 'merged') {
          onOpenTask(task);
        }
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        onContextMenu(task, event.clientX, event.clientY);
      }}
    >
      <TaskStatusIndicator
        status={task.status}
        className="sidebar-task__status"
      />
      <span className="sr-only">{task.status}</span>
      <span className="sidebar-task__title">{task.title}</span>
      <span className="sidebar-task__meta">
        {taskStatusLabel(task.status)} · {formatRelativeTime(task.updatedAt)}
      </span>
    </Button>
  );
}

export function GoalSidebar({
  goals,
  tasks,
  activeGoalId,
  activeTaskId,
  isCollapsed,
  busyGoalIds,
  startingTaskId,
  onToggleCollapse,
  onNewGoal,
  onSelectGoal,
  onRenameGoal,
  onCompleteGoal,
  onReopenGoal,
  onDeleteGoal,
  onOpenTask,
  onStartTask,
  onCompleteTask,
  onOpenSettings,
  onOpenWorkflows,
}: GoalSidebarProps) {
  const [contextMenu, setContextMenu] = useState<{
    task: SidebarTask;
    x: number;
    y: number;
  } | null>(null);
  const [goalContextMenu, setGoalContextMenu] = useState<{
    goal: GoalSummary;
    x: number;
    y: number;
  } | null>(null);
  const [renamingGoalId, setRenamingGoalId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const renameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (renamingGoalId) {
      renameInputRef.current?.focus();
    }
  }, [renamingGoalId]);

  const startRenaming = useCallback((goal: GoalSummary) => {
    setRenamingGoalId(goal.id);
    setRenameValue(goal.title);
  }, []);

  const commitRename = useCallback(
    (goal: GoalSummary) => {
      const title = renameValue.trim();
      setRenamingGoalId(null);
      if (title && title !== goal.title) {
        onRenameGoal(goal.id, title);
      }
    },
    [renameValue, onRenameGoal],
  );

  const goalRowProps = useMemo<GoalRowProps>(
    () => ({
      goals,
      tasks,
      activeGoalId,
      busyGoalIds,
      renamingGoalId,
      renameValue,
      renameInputRef,
      onSelectGoal,
      onStartRenaming: startRenaming,
      onRenameValueChange: setRenameValue,
      onCommitRename: commitRename,
      onCancelRename: () => setRenamingGoalId(null),
      onContextMenu: (goal, x, y) => setGoalContextMenu({ goal, x, y }),
    }),
    [
      goals,
      tasks,
      activeGoalId,
      busyGoalIds,
      renamingGoalId,
      renameValue,
      onSelectGoal,
      startRenaming,
      commitRename,
    ],
  );

  const taskRowProps = useMemo<TaskRowProps>(
    () => ({
      tasks,
      activeTaskId,
      onOpenTask,
      onContextMenu: (task, x, y) => setContextMenu({ task, x, y }),
    }),
    [tasks, activeTaskId, onOpenTask],
  );

  return (
    <aside
      className="goal-sidebar"
      id="goal-sidebar"
      aria-label="Goals and tasks"
    >
      <div className="goal-sidebar__header">
        {!isCollapsed && <span>Goals</span>}
        <div className="goal-sidebar__actions">
          {!isCollapsed && (
            <Button
              type="button"
              size="icon-sm"
              aria-label="New goal"
              title="New goal"
              onClick={onNewGoal}
            >
              <img
                className="goal-sidebar__new-icon"
                src={plusIcon}
                alt=""
                aria-hidden="true"
              />
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-controls="goal-sidebar"
            aria-expanded={!isCollapsed}
            aria-label={`${isCollapsed ? 'Expand' : 'Collapse'} goals sidebar`}
            title={`${isCollapsed ? 'Expand' : 'Collapse'} goals sidebar`}
            onClick={onToggleCollapse}
          >
            <img
              className={`goal-sidebar__toggle-icon${isCollapsed ? ' goal-sidebar__toggle-icon--expand' : ''}`}
              src={sidebarCollapseIcon}
              alt=""
              aria-hidden="true"
            />
          </Button>
        </div>
      </div>
      {!isCollapsed && (
        <div className="sidebar-content">
          <nav className="goal-list" aria-label="Goals">
            {goals.length === 0 ? (
              <p className="goal-list__empty">No goals yet</p>
            ) : (
              <List
                className="scrollbar-hidden"
                rowComponent={GoalRow}
                rowCount={goals.length}
                rowHeight={GOAL_ROW_HEIGHT}
                rowProps={goalRowProps}
              />
            )}
          </nav>
          <section
            className="sidebar-tasks"
            aria-labelledby="sidebar-tasks-heading"
          >
            <h2 id="sidebar-tasks-heading">Tasks</h2>
            {tasks.length === 0 ? (
              <p className="goal-list__empty">No queued tasks yet</p>
            ) : (
              <div className="sidebar-task-list">
                <List
                  className="scrollbar-hidden"
                  rowComponent={TaskRow}
                  rowCount={tasks.length}
                  rowHeight={TASK_ROW_HEIGHT}
                  rowProps={taskRowProps}
                />
              </div>
            )}
          </section>
        </div>
      )}
      <div className="goal-sidebar__footer">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Workflows"
          title="Workflows"
          onClick={onOpenWorkflows}
        >
          <Workflow aria-hidden="true" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Settings"
          title="Settings"
          onClick={onOpenSettings}
        >
          <img
            className="goal-sidebar__settings-icon"
            src={settingsIcon}
            alt=""
            aria-hidden="true"
          />
        </Button>
      </div>
      {contextMenu && (
        <ContextMenu
          position={{ x: contextMenu.x, y: contextMenu.y }}
          onClose={() => setContextMenu(null)}
          items={taskContextMenuItems({
            task: contextMenu.task,
            isStarting: startingTaskId === contextMenu.task.id,
            onOpenTask,
            onStartTask,
            onCompleteTask,
            onSelectGoal: () => onSelectGoal(contextMenu.task.goalId),
          })}
        />
      )}
      {goalContextMenu && (
        <ContextMenu
          position={{ x: goalContextMenu.x, y: goalContextMenu.y }}
          onClose={() => setGoalContextMenu(null)}
          items={goalContextMenuItems({
            goal: goalContextMenu.goal,
            hasStartedTasks: hasStartedTasks(tasks, goalContextMenu.goal.id),
            onRename: () => startRenaming(goalContextMenu.goal),
            onComplete: () => onCompleteGoal(goalContextMenu.goal.id),
            onReopen: () => onReopenGoal(goalContextMenu.goal.id),
            onDelete: () => onDeleteGoal(goalContextMenu.goal.id),
          })}
        />
      )}
    </aside>
  );
}
