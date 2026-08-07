import type { KanbanPlan, StoredKanban } from "@getpaseo/protocol/kanban/types";
import {
  DERIVED_COLUMN_KEYS,
  derivePlanColumn,
  type DerivedColumnKey,
} from "@getpaseo/protocol/kanban/derive";

export {
  DERIVED_COLUMN_KEYS,
  derivePlanColumn,
  derivePlanRunState,
  type DerivedColumnKey,
  type PlanRunState,
} from "@getpaseo/protocol/kanban/derive";

export interface DerivedBoardColumn {
  key: DerivedColumnKey;
  plans: KanbanPlan[];
}

export interface DerivedBoard {
  kanbanId: string;
  columns: DerivedBoardColumn[];
  totalCount: number;
}

function comparePlansByRecency(left: KanbanPlan, right: KanbanPlan): number {
  return right.updatedAt.localeCompare(left.updatedAt);
}

/**
 * Draft is the one column the user orders by hand, so it follows `draftOrder` and
 * appends anything the order doesn't mention yet. The running and finished columns
 * are recency-ordered — a hand-set position there would fight the next run.
 */
export function deriveBoard(kanban: StoredKanban, draftOrder: readonly string[]): DerivedBoard {
  const byColumn = new Map<DerivedColumnKey, KanbanPlan[]>(
    DERIVED_COLUMN_KEYS.map((key) => [key, []]),
  );

  for (const plan of Object.values(kanban.plans)) {
    if (plan.archivedAt !== null) {
      continue;
    }
    byColumn.get(derivePlanColumn(plan))?.push(plan);
  }

  const draftRank = new Map(draftOrder.map((planId, index) => [planId, index]));
  const drafts = byColumn.get("draft") ?? [];
  drafts.sort((left, right) => {
    const leftRank = draftRank.get(left.id);
    const rightRank = draftRank.get(right.id);
    if (leftRank !== undefined && rightRank !== undefined) {
      return leftRank - rightRank;
    }
    if (leftRank !== undefined) {
      return -1;
    }
    if (rightRank !== undefined) {
      return 1;
    }
    return comparePlansByRecency(left, right);
  });
  byColumn.get("inProgress")?.sort(comparePlansByRecency);
  byColumn.get("done")?.sort(comparePlansByRecency);

  const columns = DERIVED_COLUMN_KEYS.map((key) => ({ key, plans: byColumn.get(key) ?? [] }));
  return {
    kanbanId: kanban.id,
    columns,
    totalCount: columns.reduce((total, column) => total + column.plans.length, 0),
  };
}

/**
 * Shows a dropped draft where it is going before the daemon has confirmed it.
 * The column is derived from runs, and the run does not exist until the dispatch
 * lands, so without this the card sits in Draft for a round trip after a gesture
 * that plainly moved it. The overlay is display-only: it never invents a run, so
 * a dispatch that fails reverts by dropping the id.
 */
export function applyOptimisticDispatch(
  board: DerivedBoard,
  pendingPlanIds: readonly string[],
): DerivedBoard {
  if (pendingPlanIds.length === 0) {
    return board;
  }
  const pending = new Set(pendingPlanIds);
  const moved: KanbanPlan[] = [];
  const columns = board.columns.map((column) => {
    if (column.key !== "draft") {
      return column;
    }
    const kept: KanbanPlan[] = [];
    for (const plan of column.plans) {
      if (pending.has(plan.id)) {
        moved.push(plan);
      } else {
        kept.push(plan);
      }
    }
    return { key: column.key, plans: kept };
  });
  if (moved.length === 0) {
    return board;
  }
  return {
    ...board,
    columns: columns.map((column) =>
      column.key === "inProgress"
        ? { key: column.key, plans: [...moved, ...column.plans] }
        : column,
    ),
  };
}

/**
 * The dispatches still worth showing, against a board derived from what the
 * daemon actually holds. A plan that has left Draft has a run of its own now and
 * no longer needs the overlay; one that is gone entirely never will.
 */
export function retainPendingDispatches(
  board: DerivedBoard,
  pendingPlanIds: readonly string[],
): string[] {
  const draftIds = new Set(
    (board.columns.find((column) => column.key === "draft")?.plans ?? []).map((plan) => plan.id),
  );
  return pendingPlanIds.filter((planId) => draftIds.has(planId));
}

/** Moving a draft into the running column is a request to run it; every other
 * cross-column drop would be asking the board to contradict what actually ran. */
export type BoardDropAction =
  | { kind: "run"; planId: string }
  | { kind: "reorderDraft"; order: string[] }
  | { kind: "derived-column" }
  | { kind: "none" };

export function resolveBoardDrop(input: {
  board: DerivedBoard;
  activePlanId: string;
  targetColumn: DerivedColumnKey;
  overPlanId: string | null;
}): BoardDropAction {
  const { board, activePlanId, targetColumn, overPlanId } = input;
  const draftIds = (board.columns.find((column) => column.key === "draft")?.plans ?? []).map(
    (plan) => plan.id,
  );
  if (!draftIds.includes(activePlanId)) {
    return { kind: "none" };
  }

  if (targetColumn === "inProgress") {
    return { kind: "run", planId: activePlanId };
  }
  if (targetColumn === "done") {
    return { kind: "derived-column" };
  }
  if (overPlanId === null || overPlanId === activePlanId) {
    return { kind: "none" };
  }

  const from = draftIds.indexOf(activePlanId);
  const to = draftIds.indexOf(overPlanId);
  if (from === -1 || to === -1) {
    return { kind: "none" };
  }
  const order = [...draftIds];
  order.splice(from, 1);
  order.splice(to, 0, activePlanId);
  return { kind: "reorderDraft", order };
}

/**
 * One flat, most-relevant-first list for the overview, where a project gets a
 * single column and the reader wants running work at the top. Capped: the
 * overview is a way in, and the board itself is one click away.
 */
export function flattenBoardForOverview(board: DerivedBoard, limit: number): KanbanPlan[] {
  const order: DerivedColumnKey[] = ["inProgress", "draft", "done"];
  const flattened: KanbanPlan[] = [];
  for (const key of order) {
    const column = board.columns.find((entry) => entry.key === key);
    if (!column) {
      continue;
    }
    for (const plan of column.plans) {
      if (flattened.length >= limit) {
        return flattened;
      }
      flattened.push(plan);
    }
  }
  return flattened;
}
