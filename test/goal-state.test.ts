import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DisplayMessage, Goal } from '../src/claude.ts';
import { goalIdForRequest, updateAssistant } from '../src/lib/goalState.ts';

function assistantMessage(requestId: string): DisplayMessage {
  return {
    id: `assistant-${requestId}`,
    role: 'assistant',
    status: 'streaming',
    parts: [],
  };
}

function goal(id: string, requestId: string): Goal {
  return {
    id,
    title: `Goal ${id}`,
    workingDirectory: '/workspace',
    agentSession: null,
    artifacts: [],
    messages: [assistantMessage(requestId)],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

test('goalIdForRequest finds the goal owning an in-flight requestId', () => {
  const busyRequests = new Map([
    ['goal-a', 'request-a'],
    ['goal-b', 'request-b'],
  ]);

  assert.equal(goalIdForRequest(busyRequests, 'request-b'), 'goal-b');
});

test('goalIdForRequest returns null for an untracked requestId', () => {
  const busyRequests = new Map([['goal-a', 'request-a']]);

  assert.equal(goalIdForRequest(busyRequests, 'unknown'), null);
});

test('updateAssistant only touches the message matching the requestId, leaving other goals untouched by construction', () => {
  const requestId = 'request-b';
  const backgroundGoal = goal('goal-b', requestId);

  const updated = updateAssistant(backgroundGoal, requestId, (message) => ({
    ...message,
    status: 'complete',
  }));

  assert.equal(updated.messages[0].status, 'complete');
  // The goal object passed in is left untouched, so a caller applying this to
  // a background goal cannot accidentally mutate the currently active one.
  assert.equal(backgroundGoal.messages[0].status, 'streaming');
});
