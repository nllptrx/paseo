import type { KanbanPlan, NestedPlan, Step, StoredKanban } from "@getpaseo/protocol/kanban/types";
import type { SidebarWorkspaceEntry } from "@/hooks/sidebar-workspaces-view-model";

/**
 * Where a workspace's card lives on a kanban: the column of the plan whose steps reference it.
 * Nested-kanban children resolve to their top-level card's column, per
 * `docs/kanban-workflow-stacking-plan.md` §4 — the sidebar is execution-centric, not a second
 * board.
 */
export interface KanbanColumnRef {
  serverId: string;
  kanbanId: string;
  kanbanName: string;
  columnId: string;
  columnName: string;
  columnOrder: number;
  planId: string;
  planTitle: string;
}

export interface KanbanColumnGroup {
  key: string;
  columnId: string;
  columnName: string;
  columnOrder: number;
  rows: SidebarWorkspaceEntry[];
}

/**
 * A step "references" a workspace either by declaring it upfront (`existing` strategy) or by
 * having actually run on it (`runs[].workspaceIds`, populated once `worktree`/`reuse_previous`
 * steps materialize a workspace). Both count — the card should show wherever the work is,
 * whether declared or already underway.
 */
function collectStepWorkspaceIds(step: Step): string[] {
  const ids = new Set<string>();
  if (step.workspace.mode === "existing") {
    ids.add(step.workspace.workspaceId);
  }
  for (const run of step.runs) {
    for (const workspaceId of run.workspaceIds) {
      ids.add(workspaceId);
    }
  }
  return Array.from(ids);
}

function collectPlanWorkspaceIds(plan: KanbanPlan | NestedPlan): string[] {
  if (plan.body.type === "workflow") {
    return plan.body.steps.flatMap(collectStepWorkspaceIds);
  }
  return Object.values(plan.body.plans).flatMap((nested) =>
    nested.body.steps.flatMap(collectStepWorkspaceIds),
  );
}

/**
 * Maps every workspace referenced by a non-archived plan on this kanban to the column its
 * top-level card sits in. Skips archived plans and plans not placed in any column.
 */
export function resolveKanbanWorkspaceColumns(
  serverId: string,
  kanban: StoredKanban,
): Map<string, KanbanColumnRef> {
  const refByWorkspaceId = new Map<string, KanbanColumnRef>();

  kanban.columns.forEach((column, columnOrder) => {
    for (const planId of column.planIds) {
      const plan = kanban.plans[planId];
      if (!plan || plan.archivedAt) continue;

      const workspaceIds = collectPlanWorkspaceIds(plan);
      for (const workspaceId of workspaceIds) {
        refByWorkspaceId.set(workspaceId, {
          serverId,
          kanbanId: kanban.id,
          kanbanName: kanban.name,
          columnId: column.id,
          columnName: column.name,
          columnOrder,
          planId: plan.id,
          planTitle: plan.title,
        });
      }
    }
  });

  return refByWorkspaceId;
}

export interface KanbanSidebarSplit {
  columnGroups: KanbanColumnGroup[];
  unboundedWorkspaces: SidebarWorkspaceEntry[];
}

/**
 * Splits workspaces into board-order column groups plus the trailing Unbounded set — everything
 * with no column ref, which is everything today for a user who has never opted in.
 */
export function splitWorkspacesByKanbanColumn(
  workspaces: readonly SidebarWorkspaceEntry[],
  columnRefByWorkspaceKey: ReadonlyMap<string, KanbanColumnRef>,
): KanbanSidebarSplit {
  const rowsByColumnKey = new Map<string, SidebarWorkspaceEntry[]>();
  const columnMetaByKey = new Map<string, KanbanColumnRef>();
  const unboundedWorkspaces: SidebarWorkspaceEntry[] = [];

  for (const workspace of workspaces) {
    const ref = columnRefByWorkspaceKey.get(workspace.workspaceKey);
    if (!ref) {
      unboundedWorkspaces.push(workspace);
      continue;
    }
    const columnKey = `${ref.serverId}:${ref.kanbanId}:${ref.columnId}`;
    columnMetaByKey.set(columnKey, ref);
    const rows = rowsByColumnKey.get(columnKey);
    if (rows) {
      rows.push(workspace);
    } else {
      rowsByColumnKey.set(columnKey, [workspace]);
    }
  }

  const columnGroups = Array.from(rowsByColumnKey.entries())
    .map(([key, rows]): KanbanColumnGroup => {
      const meta = columnMetaByKey.get(key);
      if (!meta) throw new Error(`Missing column metadata for ${key}`);
      return {
        key,
        columnId: meta.columnId,
        columnName: meta.columnName,
        columnOrder: meta.columnOrder,
        rows: rows.sort((a, b) => a.name.localeCompare(b.name)),
      };
    })
    .sort((a, b) => a.columnOrder - b.columnOrder || a.columnName.localeCompare(b.columnName));

  return { columnGroups, unboundedWorkspaces };
}
