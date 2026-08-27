import {
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { useDefaultLayout } from 'react-resizable-panels';
import type { SidebarTask, WorkerRun } from '../claude';
import type { QueuedMessage } from '../hooks/useGoalStream';
import { basename } from '../lib/paths';
import { workerToolLabel } from '../lib/toolLabels';
import { Chat } from './Chat';
import { MarkdownContent } from './MarkdownContent';
import { TaskStatusIndicator } from './TaskStatusIndicator';
import { Button } from './ui/button';
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from './ui/resizable';
import { parseWorkerDiff, WorkerDiff, WorkerFileTree } from './WorkerDiff';

type WorkerScreenProps = {
  task: SidebarTask;
  run: WorkerRun | null;
  diff: string;
  draft: string;
  queued: QueuedMessage[];
  error: string | null;
  isStarting: boolean;
  onBack: () => void;
  onDraftChange: (draft: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onRemoveQueued: (id: string) => void;
  onStart: () => void;
  onStop: () => void;
  onComplete: () => void;
};

export function WorkerScreen({
  task,
  run,
  diff,
  draft,
  queued,
  error,
  isStarting,
  onBack,
  onDraftChange,
  onSubmit,
  onRemoveQueued,
  onStart,
  onStop,
  onComplete,
}: WorkerScreenProps) {
  const workerLayout = useDefaultLayout({
    id: 'rba.worker-workspace-v4',
    panelIds: ['review', 'worker-chat'],
    storage: window.localStorage,
  });
  const changedFiles = useMemo(() => parseWorkerDiff(diff), [diff]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);

  useEffect(() => {
    if (changedFiles.length === 0) {
      setSelectedFile(null);
    } else if (
      !selectedFile ||
      !changedFiles.some((file) => file.path === selectedFile)
    ) {
      setSelectedFile(changedFiles[0].path);
    }
  }, [changedFiles, selectedFile]);

  const selectFile = useCallback(
    (path: string) => {
      setSelectedFile(path);
      const index = changedFiles.findIndex((file) => file.path === path);
      document
        .getElementById(`worker-diff-${index}`)
        ?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    },
    [changedFiles],
  );

  if (!run) {
    return (
      <section className="worker-screen">
        <header className="worker-screen__header">
          <Button type="button" size="sm" variant="ghost" onClick={onBack}>
            ← Back
          </Button>
          <h1>{task.title}</h1>
          <span
            className="worker-status worker-status--queued"
            aria-hidden="true"
          />
          <span className="sr-only">queued</span>
        </header>
        <main className="task-ready">
          <div className="task-ready__content">
            <p className="task-ready__source">From {task.goalTitle}</p>
            {task.specMarkdown ? (
              <MarkdownContent className="typeset-task">
                {task.specMarkdown}
              </MarkdownContent>
            ) : (
              <p>No specification.</p>
            )}
            {error && <div className="error-message">{error}</div>}
            <div className="task-ready__actions">
              <Button type="button" disabled={isStarting} onClick={onStart}>
                {isStarting ? 'Starting…' : 'Start task'}
              </Button>
            </div>
          </div>
        </main>
      </section>
    );
  }

  const composerPlaceholder = run.sessionId
    ? 'Ask for a change or clarification'
    : 'Available after the worker finishes';
  const composerBusyPlaceholder = run.sessionId
    ? "Add a follow-up — it'll queue until this turn finishes"
    : 'Available after the worker finishes';

  return (
    <section className="worker-screen">
      <header className="worker-screen__header">
        <Button type="button" size="sm" variant="ghost" onClick={onBack}>
          ← Back
        </Button>
        <h1>{task.title}</h1>
        <TaskStatusIndicator status={run.status} baseClass="worker-status" />
        <span className="sr-only">{run.status}</span>
        {run.status !== 'working' && task.status !== 'merged' && (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={onComplete}
          >
            Mark as merged
          </Button>
        )}
      </header>

      <ResizablePanelGroup
        className="workspace worker-workspace"
        defaultLayout={workerLayout.defaultLayout}
        id="rba.worker-workspace-v4"
        onLayoutChanged={workerLayout.onLayoutChanged}
        orientation="horizontal"
      >
        <ResizablePanel defaultSize={70} id="review" minSize={40}>
          <section className="worker-review" aria-label="Worker changes">
            <WorkerFileTree
              files={changedFiles}
              selected={selectedFile}
              onPick={selectFile}
            />
            <WorkerDiff files={changedFiles} selected={selectedFile} />
          </section>
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel defaultSize={30} id="worker-chat" minSize={28}>
          <Chat
            title="Conversation"
            assistantLabel="Worker"
            toolLabel={workerToolLabel}
            messages={run.messages}
            scrollKey={task.id}
            messagesError={run.error}
            draft={draft}
            queued={queued}
            context={{
              icon: <WorktreeIcon />,
              label: basename(run.worktree),
              title: run.worktree,
            }}
            error={error}
            isBusy={run.status === 'working'}
            composerDisabled={!run.sessionId}
            composerAriaLabel="Message worker"
            placeholder={composerPlaceholder}
            busyPlaceholder={composerBusyPlaceholder}
            onDraftChange={onDraftChange}
            onSubmit={onSubmit}
            onStop={onStop}
            onRemoveQueued={onRemoveQueued}
          />
        </ResizablePanel>
      </ResizablePanelGroup>
    </section>
  );
}

function WorktreeIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <line x1="6" y1="3" x2="6" y2="15" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </svg>
  );
}
