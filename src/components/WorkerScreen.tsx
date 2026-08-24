import {
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useDefaultLayout } from 'react-resizable-panels';
import type { SidebarTask, WorkerRun } from '../claude';
import { workerToolLabel } from '../lib/toolLabels';
import { MarkdownContent } from './MarkdownContent';
import { MessageThread } from './MessageThread';
import { Button } from './ui/button';
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from './ui/resizable';
import { Textarea } from './ui/textarea';
import { parseWorkerDiff, WorkerDiff, WorkerFileTree } from './WorkerDiff';

type WorkerScreenProps = {
  task: SidebarTask;
  run: WorkerRun | null;
  diff: string;
  error: string | null;
  isStarting: boolean;
  onBack: () => void;
  onSend: (message: string) => Promise<boolean>;
  onStart: () => void;
  onStop: () => void;
  onComplete: () => void;
};

export function WorkerScreen({
  task,
  run,
  diff,
  error,
  isStarting,
  onBack,
  onSend,
  onStart,
  onStop,
  onComplete,
}: WorkerScreenProps) {
  const workerLayout = useDefaultLayout({
    id: 'rba.worker-workspace-v4',
    panelIds: ['review', 'worker-chat'],
    storage: window.localStorage,
  });
  const messages = useRef<HTMLElement>(null);
  const [draft, setDraft] = useState('');
  const [isSending, setIsSending] = useState(false);
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

  useEffect(() => {
    const container = messages.current;
    if (container) {
      container.scrollTop = container.scrollHeight;
    }
  });

  async function submitMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const message = draft.trim();
    if (
      !run ||
      !message ||
      isSending ||
      run.status === 'working' ||
      !run.sessionId
    ) {
      return;
    }
    setIsSending(true);
    const sent = await onSend(message);
    if (sent) {
      setDraft('');
    }
    setIsSending(false);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (
      event.key === 'Enter' &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  function selectFile(path: string) {
    setSelectedFile(path);
    const index = changedFiles.findIndex((file) => file.path === path);
    document
      .getElementById(`worker-diff-${index}`)
      ?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }

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

  return (
    <section className="worker-screen">
      <header className="worker-screen__header">
        <Button type="button" size="sm" variant="ghost" onClick={onBack}>
          ← Back
        </Button>
        <h1>{task.title}</h1>
        <span
          className={`worker-status worker-status--${run.status}`}
          aria-hidden="true"
        />
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
          <section className="worker-chat">
            <header className="worker-chat__header">
              <h2>Conversation</h2>
              <span>Sonnet</span>
            </header>
            <section
              className="messages worker-screen__messages"
              aria-live="polite"
              ref={messages}
            >
              <MessageThread
                assistantLabel="Worker"
                messages={run.messages}
                toolLabel={workerToolLabel}
              />
              {run.error && <div className="error-message">{run.error}</div>}
            </section>

            <footer className="composer-area worker-composer-area">
              {error && <div className="error-message">{error}</div>}
              <div className="working-directory">
                <span title={run.worktree}>Worktree: {run.worktree}</span>
              </div>
              <form className="composer" onSubmit={submitMessage}>
                <Textarea
                  className="composer__input"
                  aria-label="Message worker"
                  disabled={
                    run.status === 'working' || isSending || !run.sessionId
                  }
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder={
                    run.sessionId
                      ? 'Ask for a change or clarification'
                      : 'Available after the worker finishes'
                  }
                  rows={3}
                  value={draft}
                />
                {run.status === 'working' ? (
                  <Button type="button" variant="secondary" onClick={onStop}>
                    Stop
                  </Button>
                ) : (
                  <Button
                    type="submit"
                    disabled={!draft.trim() || isSending || !run.sessionId}
                  >
                    Send
                  </Button>
                )}
              </form>
              <p className="composer-hint">
                Enter to send · Shift+Enter for a new line
              </p>
            </footer>
          </section>
        </ResizablePanel>
      </ResizablePanelGroup>
    </section>
  );
}
