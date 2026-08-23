import type { FormEvent } from 'react';
import type { DisplayMessage } from '../claude';
import { useFollowScroll } from '../hooks/useFollowScroll';
import type { QueuedMessage } from '../hooks/useGoalStream';
import { plannerToolLabel } from '../lib/toolLabels';
import { Composer } from './Composer';
import { MessageThread } from './MessageThread';

type ChatPanelProps = {
  title: string | null;
  goalId: string | null;
  messages: DisplayMessage[];
  draft: string;
  queued: QueuedMessage[];
  workingDirectory: string | null;
  error: string | null;
  isActiveGoalBusy: boolean;
  onDraftChange: (draft: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onCancel: () => void;
  onChooseDirectory: () => void;
  onRemoveQueued: (id: string) => void;
};

export function ChatPanel({
  title,
  goalId,
  messages,
  draft,
  queued,
  workingDirectory,
  error,
  isActiveGoalBusy,
  onDraftChange,
  onSubmit,
  onCancel,
  onChooseDirectory,
  onRemoveQueued,
}: ChatPanelProps) {
  const follow = useFollowScroll(goalId, messages);

  return (
    <section className="chat">
      <header className="chat__header">
        <h1>{title ?? 'RBA'}</h1>
        <span>Sonnet</span>
      </header>

      <section
        className="messages"
        aria-live="polite"
        ref={follow.ref}
        onScroll={follow.onScroll}
      >
        {messages.length === 0 ? (
          <div className="empty-state">
            <h2>What would you like to achieve?</h2>
            <p>Describe a feature, problem, or idea to begin.</p>
          </div>
        ) : (
          <MessageThread
            assistantLabel="RBA"
            messages={messages}
            toolLabel={plannerToolLabel}
          />
        )}
      </section>

      <Composer
        draft={draft}
        queued={queued}
        workingDirectory={workingDirectory}
        error={error}
        isActiveGoalBusy={isActiveGoalBusy}
        onDraftChange={onDraftChange}
        onSubmit={onSubmit}
        onCancel={onCancel}
        onChooseDirectory={onChooseDirectory}
        onRemoveQueued={onRemoveQueued}
      />
    </section>
  );
}
