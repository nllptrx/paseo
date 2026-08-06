import type { KanbanPlan, NestedPlan, StoredKanban } from "@getpaseo/protocol/kanban/types";

function collectPlanWorkspaceIds(plan: KanbanPlan | NestedPlan): string[] {
  if (plan.body.type === "workflow") {
    const ids = new Set<string>();
    for (const step of plan.body.steps) {
      if (step.workspace.mode === "existing") {
        ids.add(step.workspace.workspaceId);
      }
      for (const run of step.runs) {
        for (const workspaceId of run.workspaceIds) {
          ids.add(workspaceId);
        }
      }
    }
    return [...ids];
  }
  return Object.values(plan.body.plans).flatMap((child) => collectPlanWorkspaceIds(child));
}

/**
 * The plan on this kanban that already covers the workspace, if any. A workspace
 * is covered when a step names it outright or a run of that step used it — the
 * two ways a plan ends up attached to a workspace.
 *
 * This is the dedup behind "Add to Kanban": pressing it twice should find the
 * existing card rather than stack a second one on the same work.
 */
export function findPlanTrackingWorkspace(
  kanban: StoredKanban,
  workspaceId: string,
): KanbanPlan | null {
  if (!workspaceId) {
    return null;
  }
  for (const plan of Object.values(kanban.plans)) {
    if (plan.archivedAt) {
      continue;
    }
    if (collectPlanWorkspaceIds(plan).includes(workspaceId)) {
      return plan;
    }
  }
  return null;
}
