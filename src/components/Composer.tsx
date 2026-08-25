import type { FormEvent, KeyboardEvent, ReactNode } from 'react';
import type { QueuedMessage } from '../hooks/useGoalStream';
import { Button } from './ui/button';
import { Textarea } from './ui/textarea';

type ComposerProps = {
  draft: string;
  queued: QueuedMessage[];
  meta?: ReactNode;
  error: string | null;
  isBusy: boolean;
  disabled?: boolean;
  ariaLabel: string;
  placeholder: string;
  busyPlaceholder: string;
  onDraftChange: (draft: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onStop: () => void;
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
  meta,
  error,
  isBusy,
  disabled = false,
  ariaLabel,
  placeholder,
  busyPlaceholder,
  onDraftChange,
  onSubmit,
  onStop,
  onRemoveQueued,
}: ComposerProps) {
  return (
    <footer className="composer-area">
      {error && <div className="error-message">{error}</div>}
      {meta}
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
          aria-label={ariaLabel}
          disabled={disabled}
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={isBusy ? busyPlaceholder : placeholder}
          rows={3}
          value={draft}
        />
        <div className="composer__actions">
          <Button type="submit" disabled={!draft.trim() || disabled}>
            {isBusy ? 'Queue' : 'Send'}
          </Button>
          {isBusy && (
            <Button type="button" variant="secondary" onClick={onStop}>
              Stop
            </Button>
          )}
        </div>
      </form>
      <p className="composer-hint">
        {isBusy
          ? 'Enter to queue · sends when the current turn finishes'
          : 'Enter to send · Shift+Enter for a new line'}
      </p>
    </footer>
  );
}
