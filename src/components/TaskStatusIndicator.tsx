import { Check, GitMerge } from 'lucide-react';

export function TaskStatusIndicator({
  status,
  baseClass = 'task__status',
  className = '',
}: {
  status: string;
  baseClass?: string;
  className?: string;
}) {
  if (status === 'completed') {
    return (
      <Check
        className={`${baseClass}-icon ${baseClass}-icon--completed ${className}`}
        aria-hidden="true"
      />
    );
  }

  if (status === 'merged') {
    return (
      <GitMerge
        className={`${baseClass}-icon ${baseClass}-icon--merged ${className}`}
        aria-hidden="true"
      />
    );
  }

  return (
    <span
      className={`${baseClass} ${baseClass}--${status} ${className}`}
      aria-hidden="true"
    />
  );
}
