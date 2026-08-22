import findingsEmptyIcon from '../assets/findings-empty.svg';
import type { Goal, SidebarTask } from '../claude';
import { AuditArtifactList } from './AuditArtifactList';
import { TaskList } from './TaskList';
import { Button } from './ui/button';
import { Textarea } from './ui/textarea';

type FindingsPanelProps = {
  goal: Goal | null;
  tasks: SidebarTask[];
  commitDisabled: boolean;
  onCommit: () => void;
  onOpenTask: (task: SidebarTask) => void;
  onPlanChange: (plan: string) => void;
  onReviewPlan: () => void;
};

export function FindingsPanel({
  goal,
  tasks,
  commitDisabled,
  onCommit,
  onOpenTask,
  onPlanChange,
  onReviewPlan,
}: FindingsPanelProps) {
  return (
    <aside className="findings" aria-label="Planning audit and plan">
      <header className="findings__header">
        <h2>Audit</h2>
      </header>
      <div className="findings__content" aria-live="polite">
        <div className="audit-list">
          {goal?.auditArtifacts.length ? (
            <AuditArtifactList artifacts={goal.auditArtifacts} />
          ) : (
            <div className="findings-empty">
              <img
                className="findings-empty__graphic"
                src={findingsEmptyIcon}
                alt=""
                aria-hidden="true"
              />
              <div className="findings-empty__copy">
                <h3>Your audit will take shape here</h3>
                <p>
                  Executed tests and other generated behavioral evidence
                  gathered by the planning agent will appear here.
                </p>
              </div>
            </div>
          )}
        </div>
        {goal && (
          <section className="plan-editor" aria-labelledby="plan-heading">
            <div className="plan-editor__header">
              <div>
                <h3 id="plan-heading">Your plan</h3>
                <p>
                  You own this document. The agent can read it, but not edit it.
                </p>
              </div>
              <Button
                type="button"
                size="sm"
                disabled={commitDisabled || !goal.planMarkdown?.trim()}
                onClick={onReviewPlan}
              >
                Review in chat
              </Button>
            </div>
            <Textarea
              className="plan-editor__input"
              aria-label="Plan"
              onChange={(event) => onPlanChange(event.target.value)}
              placeholder="Write your implementation plan in Markdown…"
              value={goal.planMarkdown ?? ''}
            />
          </section>
        )}
        {tasks.some((task) => task.status !== 'draft') && (
          <TaskList
            tasks={tasks.filter((task) => task.status !== 'draft')}
            commitDisabled={commitDisabled}
            onCommit={onCommit}
            onOpenTask={onOpenTask}
          />
        )}
      </div>
    </aside>
  );
}
