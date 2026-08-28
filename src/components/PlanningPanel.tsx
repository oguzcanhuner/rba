import type { Goal, SidebarTask } from '../claude';
import { TaskList } from './TaskList';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from './ui/collapsible';

type PlanningPanelProps = {
  goal: Goal | null;
  tasks: SidebarTask[];
  commitDisabled: boolean;
  startingTaskId: string | null;
  onCommit: () => void;
  onOpenTask: (task: SidebarTask) => void;
  onStartTask: (task: SidebarTask) => void;
  onCompleteTask: (task: SidebarTask) => void;
  onDeleteTask: (task: SidebarTask) => void;
};

export function PlanningPanel({
  goal,
  tasks,
  commitDisabled,
  startingTaskId,
  onCommit,
  onOpenTask,
  onStartTask,
  onCompleteTask,
  onDeleteTask,
}: PlanningPanelProps) {
  const artifacts = goal?.artifacts ?? [];

  return (
    <aside
      className="planning-panel scrollbar-hidden"
      aria-label="Goal workspace"
    >
      <Collapsible className="planning-section" defaultOpen>
        <CollapsibleTrigger className="planning-section__trigger">
          <span>Tasks</span>
          <span className="planning-section__count">{tasks.length}</span>
          <span className="planning-section__chevron" aria-hidden="true">
            ⌄
          </span>
        </CollapsibleTrigger>
        <CollapsibleContent className="planning-section__content">
          {goal ? (
            <TaskList
              tasks={tasks}
              commitDisabled={commitDisabled}
              startingTaskId={startingTaskId}
              onCommit={onCommit}
              onOpenTask={onOpenTask}
              onStartTask={onStartTask}
              onCompleteTask={onCompleteTask}
              onDeleteTask={onDeleteTask}
              showHeading={false}
            />
          ) : (
            <p className="planning-section__empty">
              Start a conversation to draft tasks.
            </p>
          )}
        </CollapsibleContent>
      </Collapsible>

      {artifacts.map((artifact, index) => (
        <Collapsible
          className="planning-section planning-section--artifact"
          defaultOpen={index === artifacts.length - 1}
          key={artifact.id}
        >
          <CollapsibleTrigger className="planning-section__trigger">
            <span className="planning-section__artifact-title">
              {artifact.title}
            </span>
            <span className="planning-section__kind">Artifact</span>
            <span className="planning-section__chevron" aria-hidden="true">
              ⌄
            </span>
          </CollapsibleTrigger>
          <CollapsibleContent className="planning-section__content planning-section__content--artifact">
            <iframe
              className="artifact-frame"
              src={`rba-artifact://artifact/${encodeURIComponent(artifact.id)}?updated=${encodeURIComponent(artifact.updatedAt)}`}
              title={artifact.title}
            />
          </CollapsibleContent>
        </Collapsible>
      ))}
    </aside>
  );
}
