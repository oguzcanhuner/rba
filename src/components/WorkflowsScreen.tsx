import { memo, useMemo, useState } from 'react';
import type { WorkflowStepRun } from '../claude';
import { useWorkflows } from '../hooks/useWorkflows';
import { formatRelativeTime } from '../lib/relativeTime';
import { buildWorkflowTimeline } from '../lib/workflowTimeline';
import { TaskStatusIndicator } from './TaskStatusIndicator';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from './ui/resizable';
import { WorkflowEditorDialog } from './WorkflowEditorDialog';

type WorkflowsScreenProps = {
  onBack: () => void;
};

function runStatusVariant(status: string | undefined) {
  if (status === 'completed') return 'default' as const;
  if (status === 'failed') return 'destructive' as const;
  if (status === 'running') return 'secondary' as const;
  return 'outline' as const;
}

const StepRow = memo(function StepRow({
  step,
}: {
  step: WorkflowStepRun & { visitNumber: number; routeLabel: string | null };
}) {
  const [expanded, setExpanded] = useState(false);
  const durationMs =
    step.finishedAt && step.startedAt
      ? new Date(step.finishedAt).getTime() - new Date(step.startedAt).getTime()
      : null;

  return (
    <li className="rounded-lg border border-border">
      <button
        type="button"
        className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm"
        onClick={() => setExpanded((current) => !current)}
      >
        <TaskStatusIndicator status={step.status} baseClass="task__status" />
        <span className="min-w-0 flex-1 truncate font-medium">
          {step.step}
          {step.visitNumber > 1 && (
            <span className="ml-1 text-xs text-muted-foreground">
              (visit {step.visitNumber})
            </span>
          )}
        </span>
        {step.routeLabel && (
          <span className="shrink-0 font-mono text-xs text-muted-foreground">
            {step.routeLabel}
          </span>
        )}
        {durationMs !== null && (
          <span className="shrink-0 text-xs text-muted-foreground">
            {(durationMs / 1000).toFixed(1)}s
          </span>
        )}
      </button>
      {expanded && (
        <div className="space-y-2 border-t border-border px-3 py-2 text-xs">
          {step.summary && <p className="text-foreground">{step.summary}</p>}
          {step.stdout && (
            <pre className="max-h-48 overflow-auto rounded-md bg-muted p-2 font-mono whitespace-pre-wrap">
              {step.stdout}
            </pre>
          )}
          {step.stderr && (
            <pre className="max-h-48 overflow-auto rounded-md bg-destructive/10 p-2 font-mono whitespace-pre-wrap text-destructive">
              {step.stderr}
            </pre>
          )}
          {!step.stdout && !step.stderr && (
            <p className="text-muted-foreground">(no output yet)</p>
          )}
        </div>
      )}
    </li>
  );
});

export function WorkflowsScreen({ onBack }: WorkflowsScreenProps) {
  const workflows = useWorkflows();
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingExisting, setEditingExisting] = useState(false);

  const selected = workflows.selectedWorkflow;
  const summary = workflows.workflows.find((item) => item.id === selected?.id);
  const timeline = useMemo(
    () =>
      buildWorkflowTimeline(
        workflows.activeRun?.steps ?? [],
        selected?.definition,
      ),
    [workflows.activeRun, selected],
  );

  const isRunning = workflows.activeRun?.status === 'running';
  const canResume =
    !isRunning &&
    summary?.latestRun?.status === 'running' &&
    summary.latestRun.id === workflows.activeRun?.id;

  async function chooseDirectory() {
    if (!selected) return;
    const directory = await window.workflows.pickDirectory();
    if (directory) {
      await workflows.save({
        id: selected.id,
        name: selected.name,
        description: selected.description,
        directory,
        definition: selected.definition,
      });
    }
  }

  return (
    <section className="flex h-screen w-full flex-col bg-background text-foreground">
      <header className="flex items-center gap-3 border-b border-border px-3 py-2">
        <Button type="button" size="sm" variant="ghost" onClick={onBack}>
          ← Back
        </Button>
        <h1 className="font-heading text-lg font-semibold">Workflows</h1>
        <div className="flex-1" />
        <Button
          type="button"
          size="sm"
          onClick={() => {
            setEditingExisting(false);
            setEditorOpen(true);
          }}
        >
          New workflow
        </Button>
      </header>

      {workflows.error && (
        <div className="border-b border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {workflows.error}
        </div>
      )}

      <ResizablePanelGroup className="flex-1" orientation="horizontal">
        <ResizablePanel defaultSize={32} minSize={20}>
          <ul className="h-full overflow-y-auto p-2">
            {workflows.workflows.length === 0 && (
              <li className="p-4 text-sm text-muted-foreground">
                No workflows yet. Register one from an agent conversation, or
                create one here.
              </li>
            )}
            {workflows.workflows.map((workflow) => (
              <li key={workflow.id}>
                <button
                  type="button"
                  className={`flex w-full flex-col gap-0.5 rounded-lg px-3 py-2 text-left text-sm hover:bg-muted ${
                    workflow.id === workflows.selectedId ? 'bg-muted' : ''
                  }`}
                  onClick={() => void workflows.select(workflow.id)}
                >
                  <span className="flex items-center gap-2 font-medium">
                    {workflow.latestRun?.status === 'running' && (
                      <TaskStatusIndicator status="working" />
                    )}
                    {workflow.name}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {workflow.stepCount} step
                    {workflow.stepCount === 1 ? '' : 's'}
                    {workflow.latestRun &&
                      ` · ${workflow.latestRun.status} ${formatRelativeTime(
                        workflow.latestRun.startedAt,
                      )}`}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel defaultSize={68} minSize={40}>
          {selected ? (
            <div className="flex h-full flex-col overflow-y-auto p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-base font-semibold">{selected.name}</h2>
                  {selected.description && (
                    <p className="text-sm text-muted-foreground">
                      {selected.description}
                    </p>
                  )}
                  <button
                    type="button"
                    className="mt-1 text-xs text-muted-foreground underline decoration-dotted"
                    onClick={() => void chooseDirectory()}
                  >
                    {selected.directory ?? 'Choose a working directory'}
                  </button>
                </div>
                <div className="flex shrink-0 gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setEditingExisting(true);
                      setEditorOpen(true);
                    }}
                  >
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() => void workflows.remove(selected.id)}
                  >
                    Delete
                  </Button>
                </div>
              </div>

              <div className="mt-3 flex gap-2">
                <Button
                  size="sm"
                  disabled={isRunning}
                  onClick={() => void workflows.start(selected.id)}
                >
                  {canResume ? 'Resume' : 'Run'}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={isRunning}
                  onClick={() =>
                    void workflows.start(selected.id, { fresh: true })
                  }
                >
                  Fresh
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!isRunning}
                  onClick={() => void workflows.stop()}
                >
                  Stop
                </Button>
              </div>

              {workflows.activeRun && (
                <div className="mt-4 flex items-center gap-2 text-sm">
                  <Badge variant={runStatusVariant(workflows.activeRun.status)}>
                    {workflows.activeRun.status}
                  </Badge>
                  <span className="text-muted-foreground">
                    started {formatRelativeTime(workflows.activeRun.startedAt)}
                  </span>
                  {summary && summary.latestRun && (
                    <select
                      className="ml-auto rounded-md border border-input bg-input/30 px-2 py-1 text-xs"
                      value={workflows.activeRun.id}
                      onChange={(event) =>
                        void workflows.openRun(event.target.value)
                      }
                    >
                      <option value={workflows.activeRun.id}>
                        {workflows.activeRun.id === summary.latestRun.id
                          ? 'Latest run'
                          : 'Selected run'}
                      </option>
                    </select>
                  )}
                </div>
              )}

              {workflows.activeRun?.error && (
                <div className="mt-3 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
                  <p className="font-medium">This workflow is broken.</p>
                  <p>{workflows.activeRun.error}</p>
                </div>
              )}

              <ol className="mt-4 space-y-1.5">
                {timeline.map((step) => (
                  <StepRow key={step.id} step={step} />
                ))}
                {timeline.length === 0 && (
                  <li className="text-sm text-muted-foreground">
                    No runs yet.
                  </li>
                )}
              </ol>
            </div>
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              Select a workflow.
            </div>
          )}
        </ResizablePanel>
      </ResizablePanelGroup>

      <WorkflowEditorDialog
        open={editorOpen}
        workflow={editingExisting ? selected : null}
        onOpenChange={setEditorOpen}
        onSave={async (request) => {
          await workflows.save(request);
        }}
      />
    </section>
  );
}
