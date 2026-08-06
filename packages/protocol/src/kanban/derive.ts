import type { KanbanPlan, NestedPlan, Step } from "./types.js";

/**
 * Columns are derived from what a plan's steps have actually run, never stored.
 * A stored column is a second copy of execution state that has to be pushed back
 * in sync every time an agent finishes, and it silently lies whenever that sync
 * is missed.
 *
 * Failure is deliberately not a column: a failed run still belongs to work in
 * progress, and splitting it out doubles the places a card can hide. Surfaces
 * show it as status instead.
 */
export type DerivedColumnKey = "draft" | "inProgress" | "done";

export const DERIVED_COLUMN_KEYS: readonly DerivedColumnKey[] = ["draft", "inProgress", "done"];

export type PlanRunState = "idle" | "running" | "failed" | "done";

function stepsOf(plan: KanbanPlan | NestedPlan): Step[] {
  if (plan.body.type === "workflow") {
    return plan.body.steps;
  }
  return Object.values(plan.body.plans).flatMap((child) => stepsOf(child));
}

/**
 * Coarse execution state behind both the derived column and a card's status.
 * The last run of a step is the authoritative one — earlier runs are retry history.
 */
export function derivePlanRunState(plan: KanbanPlan | NestedPlan): PlanRunState {
  const steps = stepsOf(plan);
  if (steps.length === 0) {
    return "idle";
  }

  let started = 0;
  let settled = 0;
  let failed = false;
  for (const step of steps) {
    const latestRun = step.runs.at(-1);
    if (!latestRun) {
      continue;
    }
    started += 1;
    if (latestRun.status === "running") {
      continue;
    }
    settled += 1;
    if (latestRun.status !== "succeeded" && latestRun.status !== "skipped") {
      failed = true;
    }
  }

  if (started === 0) {
    return "idle";
  }
  if (settled < started || settled < steps.length) {
    return failed ? "failed" : "running";
  }
  return failed ? "failed" : "done";
}

export function derivePlanColumn(plan: KanbanPlan | NestedPlan): DerivedColumnKey {
  const state = derivePlanRunState(plan);
  if (state === "idle") {
    return "draft";
  }
  if (state === "done") {
    return "done";
  }
  return "inProgress";
}

/**
 * The step a "run this plan" gesture should start: the first one that has not
 * settled. Steps run in order, so anything past it is still gated behind it.
 *
 * Null when nothing is left to run, or when a step is already running — a second
 * run request must not queue a duplicate turn.
 */
export function resolveNextRunnableStepId(plan: KanbanPlan | NestedPlan): string | null {
  if (plan.body.type !== "workflow") {
    return null;
  }
  for (const step of plan.body.steps) {
    const latestRun = step.runs.at(-1);
    if (latestRun?.status === "running") {
      return null;
    }
    if (latestRun?.status !== "succeeded" && latestRun?.status !== "skipped") {
      return step.id;
    }
  }
  return null;
}
