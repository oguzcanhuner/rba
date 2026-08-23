import { useEffect, useState } from 'react';
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
  onCommit: () => void;
  onOpenTask: (task: SidebarTask) => void;
};

export function PlanningPanel({
  goal,
  tasks,
  commitDisabled,
  onCommit,
  onOpenTask,
}: PlanningPanelProps) {
  const artifacts = goal?.artifacts ?? [];
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(
    null,
  );

  useEffect(() => {
    if (!artifacts.some(({ id }) => id === selectedArtifactId)) {
      setSelectedArtifactId(artifacts[0]?.id ?? null);
    }
  }, [artifacts, selectedArtifactId]);

  const selectedArtifact =
    artifacts.find(({ id }) => id === selectedArtifactId) ?? artifacts[0];

  return (
    <aside className="planning-panel" aria-label="Goal workspace">
      <Collapsible
        className="planning-section"
        defaultOpen={artifacts.length > 0}
        key={`${goal?.id ?? 'empty'}-${artifacts.length === 0}`}
      >
        <CollapsibleTrigger className="planning-section__trigger">
          <span>Artifacts</span>
          <span className="planning-section__count">{artifacts.length}</span>
          <span className="planning-section__chevron" aria-hidden="true">
            ⌄
          </span>
        </CollapsibleTrigger>
        <CollapsibleContent className="planning-section__content">
          {artifacts.length === 0 ? (
            <p className="planning-section__empty">
              Ask the planner to create an artifact when a prototype, diagram,
              or visual explanation would help.
            </p>
          ) : (
            <div className="artifacts">
              <div
                className="artifacts__tabs"
                role="tablist"
                aria-label="Artifacts"
              >
                {artifacts.map((artifact) => (
                  <button
                    aria-selected={artifact.id === selectedArtifact?.id}
                    className="artifacts__tab"
                    key={artifact.id}
                    onClick={() => setSelectedArtifactId(artifact.id)}
                    role="tab"
                    type="button"
                  >
                    {artifact.title}
                  </button>
                ))}
              </div>
              {selectedArtifact && (
                <iframe
                  className="artifact-frame"
                  src={`rba-artifact://artifact/${encodeURIComponent(selectedArtifact.id)}?updated=${encodeURIComponent(selectedArtifact.updatedAt)}`}
                  title={selectedArtifact.title}
                />
              )}
            </div>
          )}
        </CollapsibleContent>
      </Collapsible>

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
              onCommit={onCommit}
              onOpenTask={onOpenTask}
              showHeading={false}
            />
          ) : (
            <p className="planning-section__empty">
              Start a conversation to draft tasks.
            </p>
          )}
        </CollapsibleContent>
      </Collapsible>
    </aside>
  );
}
