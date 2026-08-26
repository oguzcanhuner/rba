import { memo } from 'react';
import type { DisplayMessage, DisplayTool } from '../claude';
import { toolDetail } from '../lib/toolLabels';
import { MarkdownContent } from './MarkdownContent';

type MessageThreadProps = {
  messages: DisplayMessage[];
  assistantLabel: string;
  toolLabel: (tool: DisplayTool) => string;
};

function statusLabel(message: DisplayMessage) {
  if (message.status === 'cancelled') {
    return 'Stopped';
  }

  if (message.status === 'error') {
    return 'Interrupted';
  }

  return null;
}

type MessageItemProps = {
  message: DisplayMessage;
  assistantLabel: string;
  toolLabel: (tool: DisplayTool) => string;
};

const MessageItem = memo(function MessageItem({
  message,
  assistantLabel,
  toolLabel,
}: MessageItemProps) {
  const status = statusLabel(message);

  return (
    <article className={`message message--${message.role}`}>
      <div className="message__role">
        {message.role === 'user' ? 'You' : assistantLabel}
      </div>
      {message.parts.length === 0 && message.status === 'streaming' ? (
        <div className="message__content">
          <span className="thinking">Thinking…</span>
        </div>
      ) : (
        message.parts.map((part) => {
          if (part.type === 'text') {
            return message.role === 'assistant' ? (
              <MarkdownContent
                className="message__part message__content"
                key={part.id}
              >
                {part.text}
              </MarkdownContent>
            ) : (
              <div className="message__part message__content" key={part.id}>
                {part.text}
              </div>
            );
          }

          const detail = toolDetail(part.tool);
          return (
            <div
              className={`message__part tool-use tool-use--${part.tool.status}`}
              key={part.tool.id}
            >
              <span className="tool-use__indicator" />
              <span className="tool-use__label">{toolLabel(part.tool)}</span>
              {detail && <code className="tool-use__detail">{detail}</code>}
            </div>
          );
        })
      )}
      {status && <div className="message__status">{status}</div>}
    </article>
  );
});

export function MessageThread({
  messages,
  assistantLabel,
  toolLabel,
}: MessageThreadProps) {
  return messages.map((message) => (
    <MessageItem
      key={message.id}
      message={message}
      assistantLabel={assistantLabel}
      toolLabel={toolLabel}
    />
  ));
}
