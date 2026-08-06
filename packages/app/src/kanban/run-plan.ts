import type { KanbanPlan, NestedPlan, Step } from "@getpaseo/protocol/kanban/types";

function isSettled(step: Step): boolean {
  const latestRun = step.runs.at(-1);
  return latestRun?.status === "succeeded" || latestRun?.status === "skipped";
}

/**
 * The step a "run this plan" gesture should start: the first one that has not
 * settled. Steps run in order, so anything past the first unsettled step is
 * still gated behind it and starting it would skip the gate.
 *
 * Null when the plan has nothing left to run, or when a step is already running —
 * a second run request must not queue a duplicate turn.
 */
export function resolveNextRunnableStepId(plan: KanbanPlan | NestedPlan): string | null {
  if (plan.body.type !== "workflow") {
    return null;
  }
  for (const step of plan.body.steps) {
    if (step.runs.at(-1)?.status === "running") {
      return null;
    }
    if (!isSettled(step)) {
      return step.id;
    }
  }
  return null;
}
