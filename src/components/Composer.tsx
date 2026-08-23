import type { FormEvent, KeyboardEvent } from 'react';
import type { QueuedMessage } from '../hooks/useGoalStream';
import { Button } from './ui/button';
import { Textarea } from './ui/textarea';

type ComposerProps = {
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

export function Composer({
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
}: ComposerProps) {
  return (
    <footer className="composer-area">
      {error && <div className="error-message">{error}</div>}
      <div className="working-directory">
        <span title={workingDirectory ?? undefined}>
          Working directory: {workingDirectory ?? 'Loading…'}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          disabled={isActiveGoalBusy}
          onClick={onChooseDirectory}
        >
          Choose folder
        </Button>
      </div>
      {queued.length > 0 && (
        <ul className="composer-queue" aria-label="Queued messages">
          {queued.map((message) => (
            <li className="composer-queue__item" key={message.id}>
              <span className="composer-queue__label">Queued</span>
              <span className="composer-queue__text">{message.text}</span>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                aria-label="Remove queued message"
                onClick={() => onRemoveQueued(message.id)}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
      <form className="composer" onSubmit={onSubmit}>
        <Textarea
          className="composer__input"
          aria-label="Message RBA"
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={isActiveGoalBusy ? 'Steer RBA…' : 'Message RBA'}
          rows={3}
          value={draft}
        />
        <div className="composer__actions">
          <Button type="submit" disabled={!draft.trim()}>
            {isActiveGoalBusy ? 'Queue' : 'Send'}
          </Button>
          {isActiveGoalBusy && (
            <Button type="button" variant="secondary" onClick={onCancel}>
              Stop
            </Button>
          )}
        </div>
      </form>
      <p className="composer-hint">
        {isActiveGoalBusy
          ? 'Enter to queue · sends when the current turn finishes'
          : 'Enter to send · Shift+Enter for a new line'}
      </p>
    </footer>
  );
}
