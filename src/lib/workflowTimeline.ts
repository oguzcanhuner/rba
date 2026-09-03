import type { WorkflowDefinition, WorkflowStepRun } from '../claude';

export function workflowRunControls(
  run: { id: string; status: string; isActive?: boolean } | null,
  latestRunId: string | null,
) {
  const isRunning = run?.isActive === true;
  return {
    isRunning,
    canResume:
      !isRunning && run?.status === 'running' && run.id === latestRunId,
  };
}

export type TimelineRow = WorkflowStepRun & {
  /** 1-based occurrence of this step name within the run, so a loop shows
   * as one row per visit instead of collapsing repeats into one. */
  visitNumber: number;
  /** Human-readable routing, e.g. `→ review` or `fail → fix`, or null once
   * the step has no further route (a terminal step, or still running). */
  routeLabel: string | null;
};

/** Steps already come back from the store in `position` order, including
 * repeats from loops; this only adds per-visit numbering and a routing
 * label derived from the workflow definition, without reordering anything. */
export function buildWorkflowTimeline(
  steps: WorkflowStepRun[],
  definition: WorkflowDefinition | null | undefined,
): TimelineRow[] {
  const visitCounts = new Map<string, number>();

  return steps.map((step) => {
    const visitNumber = (visitCounts.get(step.step) ?? 0) + 1;
    visitCounts.set(step.step, visitNumber);

    return {
      ...step,
      visitNumber,
      routeLabel: routeLabelFor(step, definition),
    };
  });
}

function routeLabelFor(
  step: WorkflowStepRun,
  definition: WorkflowDefinition | null | undefined,
): string | null {
  const spec = definition?.steps?.[step.step];
  if (!spec || spec.type === 'terminal') {
    return null;
  }

  if (step.status === 'pass') {
    const target = spec.onPass ?? spec.next;
    return target ? `→ ${target}` : null;
  }

  if (step.status === 'fail') {
    return spec.onFail ? `fail → ${spec.onFail}` : null;
  }

  return null;
}
