import type { FormEvent } from 'react';
import type { DisplayMessage, DisplayTool } from '../claude';
import { useFollowScroll } from '../hooks/useFollowScroll';
import type { QueuedMessage } from '../hooks/useGoalStream';
import type { ComposerContext } from './Composer';
import { Composer } from './Composer';
import { MessageThread } from './MessageThread';

type ChatProps = {
  title: string;
  modelLabel?: string;
  assistantLabel: string;
  toolLabel: (tool: DisplayTool) => string;
  messages: DisplayMessage[];
  scrollKey: string | null;
  emptyState?: { title: string; description: string };
  messagesError?: string | null;
  draft: string;
  queued: QueuedMessage[];
  context?: ComposerContext;
  error: string | null;
  isBusy: boolean;
  composerDisabled?: boolean;
  composerAriaLabel: string;
  placeholder: string;
  busyPlaceholder: string;
  onDraftChange: (draft: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onStop: () => void;
  onRemoveQueued: (id: string) => void;
};

/** The one chat visual shared by the planner and a worker's conversation:
 * header, message list, and composer. The only intended divergence between
 * callers is the path chip in the composer bar (working directory vs.
 * worktree path). */
export function Chat({
  title,
  modelLabel = 'Sonnet',
  assistantLabel,
  toolLabel,
  messages,
  scrollKey,
  emptyState,
  messagesError,
  draft,
  queued,
  context,
  error,
  isBusy,
  composerDisabled = false,
  composerAriaLabel,
  placeholder,
  busyPlaceholder,
  onDraftChange,
  onSubmit,
  onStop,
  onRemoveQueued,
}: ChatProps) {
  const follow = useFollowScroll(scrollKey, messages);

  return (
    <section className="chat">
      <header className="chat__header">
        <h1>{title}</h1>
        <span>{modelLabel}</span>
      </header>

      <section
        className="messages"
        aria-live="polite"
        ref={follow.ref}
        onScroll={follow.onScroll}
      >
        {messages.length === 0 && emptyState ? (
          <div className="empty-state">
            <h2>{emptyState.title}</h2>
            <p>{emptyState.description}</p>
          </div>
        ) : (
          <MessageThread
            assistantLabel={assistantLabel}
            messages={messages}
            toolLabel={toolLabel}
          />
        )}
        {messagesError && <div className="error-message">{messagesError}</div>}
      </section>

      <Composer
        draft={draft}
        queued={queued}
        context={context}
        error={error}
        isBusy={isBusy}
        disabled={composerDisabled}
        ariaLabel={composerAriaLabel}
        placeholder={placeholder}
        busyPlaceholder={busyPlaceholder}
        onDraftChange={onDraftChange}
        onSubmit={onSubmit}
        onStop={onStop}
        onRemoveQueued={onRemoveQueued}
      />
    </section>
  );
}
