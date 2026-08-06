import { selectPrHintFromStatus } from "@/git/pr-hint";
import type { PrHint } from "@/git/pr-hint";
import { selectWorkspaceServiceSummary } from "@/components/sidebar/workspace-meta-row";
import type { WorkspaceServiceSummary } from "@/components/sidebar/workspace-meta-row";
import { useWorkspaceFields, useWorkspaceStatusesByIds } from "@/stores/session-store-hooks";
import type { WorkspaceDescriptor } from "@/stores/session-store";

export interface KanbanPlanWorkspaceSignals {
  statusByWorkspaceId: ReadonlyMap<string, WorkspaceDescriptor["status"]>;
  /** Branch of the plan's first workspace, or null when it has none. A plan can
   * span several workspaces; listing every branch would crowd out the title. */
  branch: string | null;
  prHint: PrHint | null;
  serviceSummary: WorkspaceServiceSummary | null;
  isWorktree: boolean;
  diffStat: { additions: number; deletions: number } | null;
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
  // One workspace's worth of detail: the plan's first. Several workspaces' worth
  // of branches and change requests would crowd out the title the card is for.
  const details = useWorkspaceFields(serverId, workspaceIds[0] ?? null, (workspace) => ({
    branch: normalizeBranch(workspace.gitRuntime?.currentBranch),
    prHint: selectPrHintFromStatus(workspace.githubRuntime?.pullRequest, workspace.forge),
    serviceSummary: selectWorkspaceServiceSummary(workspace.scripts),
    isWorktree: workspace.workspaceKind === "worktree",
    diffStat: workspace.diffStat,
  }));
  return {
    statusByWorkspaceId,
    branch: details?.branch ?? null,
    prHint: details?.prHint ?? null,
    serviceSummary: details?.serviceSummary ?? null,
    isWorktree: details?.isWorktree ?? false,
    diffStat: details?.diffStat ?? null,
  };
}
