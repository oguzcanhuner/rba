import type { FormEvent } from 'react';
import type { DisplayMessage } from '../claude';
import type { QueuedMessage } from '../hooks/useGoalStream';
import { displayPath } from '../lib/paths';
import { plannerToolLabel } from '../lib/toolLabels';
import { Chat } from './Chat';

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
  return (
    <Chat
      title={title ?? 'RBA'}
      assistantLabel="RBA"
      toolLabel={plannerToolLabel}
      messages={messages}
      scrollKey={goalId}
      emptyState={{
        title: 'What would you like to achieve?',
        description: 'Describe a feature, problem, or idea to begin.',
      }}
      draft={draft}
      queued={queued}
      context={{
        icon: <FolderIcon />,
        label: workingDirectory ? displayPath(workingDirectory) : 'Loading…',
        title: workingDirectory ?? 'Loading…',
        onClick: onChooseDirectory,
        disabled: isActiveGoalBusy,
      }}
      error={error}
      isBusy={isActiveGoalBusy}
      composerAriaLabel="Message RBA"
      placeholder="Message RBA"
      busyPlaceholder="Add a follow-up — it'll queue until this turn finishes"
      onDraftChange={onDraftChange}
      onSubmit={onSubmit}
      onStop={onCancel}
      onRemoveQueued={onRemoveQueued}
    />
  );
}

function FolderIcon() {
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
      <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />
    </svg>
  );
}
