import type { Task } from '../claude';
import { MarkdownContent } from './MarkdownContent';
import { Button } from './ui/button';

type TaskListProps = {
  tasks: Task[];
  commitDisabled: boolean;
  onCommit: () => void;
  onOpenWorker: (task: Task) => void;
  onStartWorker: (task: Task) => void;
};

export function TaskList({
  tasks,
  commitDisabled,
  onCommit,
  onOpenWorker,
  onStartWorker,
}: TaskListProps) {
  const draftCount = tasks.filter((task) => task.status === 'draft').length;

  return (
    <section className="tasks" aria-labelledby="tasks-heading">
      <header className="tasks__header">
        <div className="tasks__title">
          <h3 id="tasks-heading">Tasks</h3>
          <span>{tasks.length}</span>
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
          Tasks will appear here once the exploration is ready to break down.
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
                        onClick={() => onStartWorker(task)}
                      >
                        Start task
                      </Button>
                    ) : (
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        onClick={() => onOpenWorker(task)}
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
