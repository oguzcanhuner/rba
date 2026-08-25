import type { FormEvent } from 'react';
import type { DisplayMessage } from '../claude';
import type { QueuedMessage } from '../hooks/useGoalStream';
import { plannerToolLabel } from '../lib/toolLabels';
import { Chat } from './Chat';
import { Button } from './ui/button';

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
      meta={
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
      }
      error={error}
      isBusy={isActiveGoalBusy}
      composerAriaLabel="Message RBA"
      placeholder="Message RBA"
      busyPlaceholder="Steer RBA…"
      onDraftChange={onDraftChange}
      onSubmit={onSubmit}
      onStop={onCancel}
      onRemoveQueued={onRemoveQueued}
    />
  );
}
