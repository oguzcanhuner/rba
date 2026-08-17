import findingsEmptyIcon from '../assets/findings-empty.svg';
import type { Goal, SidebarTask } from '../claude';
import { MarkdownContent } from './MarkdownContent';
import { TaskList } from './TaskList';

type FindingsPanelProps = {
  goal: Goal | null;
  commitDisabled: boolean;
  onCommit: () => void;
  onOpenTask: (task: SidebarTask) => void;
};

export function FindingsPanel({
  goal,
  commitDisabled,
  onCommit,
  onOpenTask,
}: FindingsPanelProps) {
  return (
    <aside className="findings" aria-label="Goal findings">
      <header className="findings__header">
        <h2>Findings</h2>
      </header>
      <div className="findings__content" aria-live="polite">
        <div
          className={`findings__document${goal?.findingsMarkdown ? '' : ' findings__document--empty'}`}
        >
          {goal?.findingsMarkdown ? (
            <MarkdownContent className="typeset-findings">
              {goal.findingsMarkdown}
            </MarkdownContent>
          ) : (
            <div className="findings-empty">
              <img
                className="findings-empty__graphic"
                src={findingsEmptyIcon}
                alt=""
                aria-hidden="true"
              />
              <div className="findings-empty__copy">
                <h3>Findings will take shape here</h3>
                <p>
                  As the goal takes shape, key insights and decisions will be
                  gathered into a clear, evolving summary.
                </p>
              </div>
            </div>
          )}
        </div>
        {goal && (
          <TaskList
            tasks={goal.tasks}
            commitDisabled={commitDisabled}
            onCommit={onCommit}
            onOpenTask={(task) =>
              onOpenTask({ ...task, goalId: goal.id, goalTitle: goal.title })
            }
          />
        )}
      </div>
    </aside>
  );
}
