import plusIcon from '../assets/plus.svg';
import settingsIcon from '../assets/settings.svg';
import sidebarCollapseIcon from '../assets/sidebar-collapse.svg';
import type { GoalSummary, SidebarTask } from '../claude';
import { Button } from './ui/button';

type GoalSidebarProps = {
  goals: GoalSummary[];
  tasks: SidebarTask[];
  activeGoalId: string | null;
  isCollapsed: boolean;
  /** Goals with a turn currently streaming, whether or not displayed. */
  busyGoalIds: Set<string>;
  onToggleCollapse: () => void;
  onNewGoal: () => void;
  onSelectGoal: (id: string) => void;
  onOpenTask: (task: SidebarTask) => void;
  onOpenSettings: () => void;
};

export function GoalSidebar({
  goals,
  tasks,
  activeGoalId,
  isCollapsed,
  busyGoalIds,
  onToggleCollapse,
  onNewGoal,
  onSelectGoal,
  onOpenTask,
  onOpenSettings,
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
                  aria-current={goal.id === activeGoalId ? 'page' : undefined}
                  aria-busy={busyGoalIds.has(goal.id)}
                  title={goal.title}
                  onClick={() => onSelectGoal(goal.id)}
                >
                  <span className="goal-list__title">{goal.title}</span>
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
      <div className="goal-sidebar__footer">
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
    </aside>
  );
}
