import plusIcon from '../assets/plus.svg';
import sidebarCollapseIcon from '../assets/sidebar-collapse.svg';
import type { GoalSummary, SidebarTask } from '../claude';
import { Button } from './ui/button';

type GoalSidebarProps = {
  goals: GoalSummary[];
  tasks: SidebarTask[];
  activeGoalId: string | null;
  isCollapsed: boolean;
  isBusy: boolean;
  onToggleCollapse: () => void;
  onNewGoal: () => void;
  onSelectGoal: (id: string) => void;
  onOpenTask: (task: SidebarTask) => void;
};

export function GoalSidebar({
  goals,
  tasks,
  activeGoalId,
  isCollapsed,
  isBusy,
  onToggleCollapse,
  onNewGoal,
  onSelectGoal,
  onOpenTask,
}: GoalSidebarProps) {
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
              disabled={isBusy}
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
              goals.map((goal) => (
                <Button
                  className="goal-list__item"
                  type="button"
                  variant="ghost"
                  key={goal.id}
                  disabled={isBusy}
                  aria-current={goal.id === activeGoalId ? 'page' : undefined}
                  title={goal.title}
                  onClick={() => onSelectGoal(goal.id)}
                >
                  {goal.title}
                </Button>
              ))
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
                {tasks.map((task) => (
                  <Button
                    className="sidebar-task"
                    type="button"
                    variant="ghost"
                    key={task.id}
                    title={task.title}
                    onClick={() => onOpenTask(task)}
                  >
                    <span
                      className={`sidebar-task__status task__status task__status--${task.status}`}
                      aria-hidden="true"
                    />
                    <span className="sr-only">{task.status}</span>
                    <span className="sidebar-task__title">{task.title}</span>
                    <span className="sidebar-task__goal">{task.goalTitle}</span>
                  </Button>
                ))}
              </div>
            )}
          </section>
        </div>
      )}
    </aside>
  );
}
