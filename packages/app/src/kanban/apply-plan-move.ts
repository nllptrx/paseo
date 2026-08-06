import type { Column, StoredKanban } from "@getpaseo/protocol/kanban/types";

export interface PlanMoveTarget {
  planId: string;
  columnId: string;
  index: number;
}

/**
 * Resolves where a board drag should land. `overId` is either a plan id or a
 * `column:<columnId>` droppable. Same-column moves use arrayMove index math so
 * the server gets the final index after removal; cross-column inserts at the
 * over plan's index (or at the end when dropping on the column body).
 */
export function resolveBoardPlanDrop(input: {
  columns: readonly Pick<Column, "id" | "planIds">[];
  planId: string;
  overId: string;
}): PlanMoveTarget | null {
  const { columns, planId, overId } = input;
  if (overId === planId) {
    return null;
  }

  let sourceColumnId: string | null = null;
  let sourceIndex = -1;
  for (const column of columns) {
    const index = column.planIds.indexOf(planId);
    if (index !== -1) {
      sourceColumnId = column.id;
      sourceIndex = index;
      break;
    }
  }
  if (sourceColumnId === null || sourceIndex < 0) {
    return null;
  }

  const columnPrefix = "column:";
  if (overId.startsWith(columnPrefix)) {
    const columnId = overId.slice(columnPrefix.length);
    const target = columns.find((column) => column.id === columnId);
    if (!target) {
      return null;
    }
    if (columnId === sourceColumnId) {
      const lastIndex = Math.max(0, target.planIds.length - 1);
      if (sourceIndex === lastIndex) {
        return null;
      }
      return { planId, columnId, index: lastIndex };
    }
    return { planId, columnId, index: target.planIds.length };
  }

  let targetColumnId: string | null = null;
  let overIndex = -1;
  for (const column of columns) {
    const index = column.planIds.indexOf(overId);
    if (index !== -1) {
      targetColumnId = column.id;
      overIndex = index;
      break;
    }
  }
  if (targetColumnId === null || overIndex < 0) {
    return null;
  }

  if (targetColumnId === sourceColumnId) {
    if (sourceIndex === overIndex) {
      return null;
    }
    return { planId, columnId: targetColumnId, index: overIndex };
  }

  return { planId, columnId: targetColumnId, index: overIndex };
}

/**
 * Applies a top-level plan move to a StoredKanban (parentPlanId null). Nested
 * boards are left untouched — their moves go through a separate board instance.
 */
export function applyTopLevelPlanMove(
  kanban: StoredKanban,
  move: PlanMoveTarget,
): StoredKanban | null {
  const columns = kanban.columns.map((column) => ({
    ...column,
    planIds: [...column.planIds],
  }));

  let removed = false;
  for (const column of columns) {
    const index = column.planIds.indexOf(move.planId);
    if (index !== -1) {
      column.planIds.splice(index, 1);
      removed = true;
      break;
    }
  }
  if (!removed) {
    return null;
  }

  const target = columns.find((column) => column.id === move.columnId);
  if (!target) {
    return null;
  }
  const clampedIndex = Math.max(0, Math.min(move.index, target.planIds.length));
  target.planIds.splice(clampedIndex, 0, move.planId);

  const plan = kanban.plans[move.planId];
  const plans = plan
    ? {
        ...kanban.plans,
        [move.planId]: {
          ...plan,
          lastMove: { at: new Date().toISOString(), by: "user" as const },
          updatedAt: new Date().toISOString(),
        },
      }
    : kanban.plans;

  return {
    ...kanban,
    columns,
    plans,
    updatedAt: new Date().toISOString(),
  };
}
