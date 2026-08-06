import type { KanbanPlan, NestedPlan, Step, StoredKanban } from "@getpaseo/protocol/kanban/types";

/**
 * Columns are derived from what the plan's steps have actually run, not stored on
 * the plan. A stored column is a second copy of execution state that has to be
 * pushed back in sync every time an agent finishes, and it silently lies whenever
 * that sync is missed.
 *
 * Failure and blocked are deliberately not columns: a failed run still belongs to
 * work in progress, and splitting it out doubles the places a card can hide. The
 * card surfaces those as status instead.
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
 * Coarse execution state behind both the derived column and the card's status.
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
