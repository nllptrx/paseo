import type { KanbanPlan, NestedPlan, Step } from "@getpaseo/protocol/kanban/types";

export interface PlanStepProgress {
  done: number;
  total: number;
}

function isStepDone(step: Step): boolean {
  const latestRun = step.runs.at(-1);
  return latestRun?.status === "succeeded" || latestRun?.status === "skipped";
}

/** "2/5"-shaped step progress for a workflow plan; null for nested-kanban plans,
 * which show a column/plan count instead (rendered by the card). */
export function deriveWorkflowStepProgress(steps: Step[]): PlanStepProgress {
  return { done: steps.filter(isStepDone).length, total: steps.length };
}

/**
 * Workspace ids referenced by a plan's most recent step runs, so the card's
 * status dot can read the exact signal the sidebar already derives per
 * workspace instead of inventing a new one. Nested-kanban plans aggregate
 * their children's workspace ids one level deep (children are workflow-only).
 */
export function deriveKanbanPlanWorkspaceIds(plan: KanbanPlan | NestedPlan): string[] {
  if (plan.body.type === "workflow") {
    const ids = new Set<string>();
    for (const step of plan.body.steps) {
      const latestRun = step.runs.at(-1);
      if (latestRun) {
        for (const workspaceId of latestRun.workspaceIds) {
          ids.add(workspaceId);
        }
      }
    }
    return [...ids];
  }

  const ids = new Set<string>();
  for (const childPlan of Object.values(plan.body.plans)) {
    for (const workspaceId of deriveKanbanPlanWorkspaceIds(childPlan)) {
      ids.add(workspaceId);
    }
  }
  return [...ids];
}
