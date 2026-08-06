import { useWorkspaceFields, useWorkspaceStatusesByIds } from "@/stores/session-store-hooks";
import type { WorkspaceDescriptor } from "@/stores/session-store";

export interface KanbanPlanWorkspaceSignals {
  statusByWorkspaceId: ReadonlyMap<string, WorkspaceDescriptor["status"]>;
  /** Branch of the plan's first workspace, or null when it has none. A plan can
   * span several workspaces; listing every branch would crowd out the title. */
  branch: string | null;
}

function normalizeBranch(branch: string | null | undefined): string | null {
  const trimmed = branch?.trim();
  return trimmed ? trimmed : null;
}

/** The live workspace signals a kanban card reads: the aggregate status of every
 * workspace its steps touched, plus the branch its work sits on. */
export function useKanbanPlanWorkspaceSignals(
  serverId: string,
  workspaceIds: readonly string[],
): KanbanPlanWorkspaceSignals {
  const statusByWorkspaceId = useWorkspaceStatusesByIds(serverId, workspaceIds);
  const branch = useWorkspaceFields(serverId, workspaceIds[0] ?? null, (workspace) =>
    normalizeBranch(workspace.gitRuntime?.currentBranch),
  );
  return { statusByWorkspaceId, branch: branch ?? null };
}
