import type { FormEvent, KeyboardEvent, ReactNode } from 'react';
import type { QueuedMessage } from '../hooks/useGoalStream';
import { Textarea } from './ui/textarea';

export type ComposerContext = {
  icon: ReactNode;
  label: string;
  title: string;
  onClick?: () => void;
  disabled?: boolean;
};

type ComposerProps = {
  draft: string;
  queued: QueuedMessage[];
  context?: ComposerContext;
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

function ComposerChip({
  icon,
  label,
  title,
  onClick,
  disabled,
}: ComposerContext) {
  const className = 'composer__chip';
  if (onClick) {
    return (
      <button
        type="button"
        className={className}
        title={title}
        aria-label={`Working directory: ${title} — choose folder`}
        disabled={disabled}
        onClick={onClick}
      >
        {icon}
        <span className="composer__chip-label">{label}</span>
      </button>
    );
  }
  return (
    <span
      className={className}
      title={title}
      role="note"
      aria-label={`Working directory: ${title}`}
    >
      {icon}
      <span className="composer__chip-label">{label}</span>
    </span>
  );
}

export function Composer({
  draft,
  queued,
  context,
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
  const hasDraft = draft.trim().length > 0;

  return (
    <footer className="composer-area">
      {error && <div className="error-message">{error}</div>}
      {queued.length > 0 && (
        <ul className="composer-queue" aria-label="Queued messages">
          {queued.map((message) => (
            <li
              className="composer-queue__item"
              key={message.id}
              title={message.text}
            >
              <span className="composer-queue__label">Queued</span>
              <span className="composer-queue__text">{message.text}</span>
              <button
                type="button"
                className="composer-queue__remove"
                aria-label="Remove queued message"
                onClick={() => onRemoveQueued(message.id)}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        className={`composer${isBusy ? ' composer--busy' : ''}`}
        onSubmit={onSubmit}
      >
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
        <div className="composer__bar">
          {context && <ComposerChip {...context} />}
          <div className="composer__spacer" />
          <span
            className={`composer__sendhint${hasDraft ? ' composer__sendhint--active' : ''}`}
          >
            {isBusy ? (
              <>
                <kbd>⏎</kbd> queue
              </>
            ) : hasDraft ? (
              <>
                <kbd>⏎</kbd> send
              </>
            ) : (
              <>
                <kbd>⏎</kbd> send · <kbd>⇧⏎</kbd> newline
              </>
            )}
          </span>
          {isBusy && (
            <button type="button" className="composer__stop" onClick={onStop}>
              <span className="composer__stop-dot" aria-hidden="true" />
              Stop
            </button>
          )}
        </div>
        <button
          type="submit"
          className="sr-only"
          disabled={!draft.trim() || disabled}
        >
          {isBusy ? 'Queue' : 'Send'}
        </button>
      </form>
    </footer>
  );
}
