import type { KanbanPlan, NestedPlan, StoredKanban } from "@getpaseo/protocol/kanban/types";

/**
 * Resolves a plan by id, one level deep at most: `parentPlanId` set means the
 * plan lives inside a `nested_kanban` plan's own plan map. Nested kanbans are
 * one level deep by protocol, so this never recurses further.
 */
export function resolveKanbanPlan(
  kanban: StoredKanban,
  parentPlanId: string | null,
  planId: string,
): KanbanPlan | NestedPlan | null {
  if (!parentPlanId) {
    return kanban.plans[planId] ?? null;
  }
  const parent = kanban.plans[parentPlanId];
  if (!parent || parent.body.type !== "nested_kanban") {
    return null;
  }
  return parent.body.plans[planId] ?? null;
}
