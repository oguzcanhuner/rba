import type { Task } from '../claude';
import { MarkdownContent } from './MarkdownContent';
import { Button } from './ui/button';

type TaskListProps<T extends Task> = {
  tasks: T[];
  commitDisabled: boolean;
  onCommit: () => void;
  onOpenTask: (task: T) => void;
  showHeading?: boolean;
};

export function TaskList<T extends Task>({
  tasks,
  commitDisabled,
  onCommit,
  onOpenTask,
  showHeading = true,
}: TaskListProps<T>) {
  const draftCount = tasks.filter((task) => task.status === 'draft').length;

  return (
    <section
      className="tasks"
      aria-label={showHeading ? undefined : 'Tasks'}
      aria-labelledby={showHeading ? 'tasks-heading' : undefined}
    >
      <header
        className={`tasks__header${showHeading ? '' : ' tasks__header--actions-only'}`}
      >
        <div className="tasks__title">
          {showHeading && <h3 id="tasks-heading">Tasks</h3>}
          {showHeading && <span>{tasks.length}</span>}
        </div>
        {draftCount > 0 && (
          <Button
            type="button"
            size="sm"
            disabled={commitDisabled}
            onClick={onCommit}
          >
            Commit {draftCount}
          </Button>
        )}
      </header>

      {tasks.length === 0 ? (
        <p className="tasks__empty">
          Tasks will appear here once the goal is ready to break down.
        </p>
      ) : (
        <div className="tasks__list">
          {tasks.map((task) => (
            <details className="task" key={task.id}>
              <summary className="task__summary">
                <span className="task__sequence">{task.sequence}</span>
                <span className={`task__status task__status--${task.status}`}>
                  {task.status}
                </span>
                <span className="task__title">{task.title}</span>
              </summary>
              <div className="task__spec">
                {task.specMarkdown ? (
                  <MarkdownContent className="typeset-task">
                    {task.specMarkdown}
                  </MarkdownContent>
                ) : (
                  <p>No specification.</p>
                )}
                {task.status !== 'draft' && (
                  <div className="task__actions">
                    {task.status === 'queued' ? (
                      <Button
                        type="button"
                        size="sm"
                        disabled={commitDisabled}
                        onClick={() => onOpenTask(task)}
                      >
                        Open task
                      </Button>
                    ) : (
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        onClick={() => onOpenTask(task)}
                      >
                        Open worker
                      </Button>
                    )}
                  </div>
                )}
              </div>
            </details>
          ))}
        </div>
      )}
    </section>
  );
}
