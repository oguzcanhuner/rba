import type {
  DisplayMessage,
  DisplayPart,
  Goal,
  GoalSummary,
  ToolStatus,
} from '../claude';

export function appendText(
  parts: DisplayPart[],
  text: string,
  requestId: string,
): DisplayPart[] {
  const lastPart = parts.at(-1);

  if (lastPart?.type === 'text') {
    return [
      ...parts.slice(0, -1),
      { type: 'text', id: lastPart.id, text: lastPart.text + text },
    ];
  }

  return [
    ...parts,
    { type: 'text', id: `${requestId}-text-${parts.length}`, text },
  ];
}

export function finishTools(parts: DisplayPart[], status: ToolStatus) {
  return parts.map((part) =>
    part.type === 'tool' && part.tool.status === 'running'
      ? { ...part, tool: { ...part.tool, status } }
      : part,
  );
}

export function goalTitle(message: string) {
  const title = message.replace(/\s+/g, ' ').trim();
  return title.length <= 60 ? title : `${title.slice(0, 57).trimEnd()}…`;
}

export function summaryOf(goal: Goal): GoalSummary {
  const {
    agentSession: _agentSession,
    findingsMarkdown: _findingsMarkdown,
    auditArtifacts: _auditArtifacts,
    planMarkdown: _planMarkdown,
    messages: _messages,
    ...summary
  } = goal;
  return summary;
}

export function byNewestCreation(left: GoalSummary, right: GoalSummary) {
  return right.createdAt.localeCompare(left.createdAt);
}

export function restoreInterruptedMessages(goal: Goal): Goal {
  return {
    ...goal,
    messages: goal.messages.map((message) =>
      message.status === 'streaming'
        ? {
            ...message,
            status: 'error',
            parts: finishTools(message.parts, 'error'),
          }
        : message,
    ),
  };
}

export function updateAssistant(
  goal: Goal,
  requestId: string,
  update: (message: DisplayMessage) => DisplayMessage,
): Goal {
  return {
    ...goal,
    updatedAt: new Date().toISOString(),
    messages: goal.messages.map((message) =>
      message.id === `assistant-${requestId}` ? update(message) : message,
    ),
  };
}
