import type { AggregatedKanban } from "@/kanban/aggregated-kanbans";

/**
 * Resolves the kanban whose Orchestrator lives in the given workspace. Nothing
 * stops two kanbans from pointing at one workspace, so ties break on kanban id
 * to keep the pane stable across refetches rather than following list order.
 */
export function resolveOrchestratorKanban(input: {
  kanbans: readonly AggregatedKanban[];
  serverId: string;
  workspaceId: string;
}): AggregatedKanban | null {
  const { kanbans, serverId, workspaceId } = input;
  if (!serverId || !workspaceId) {
    return null;
  }
  const matches = kanbans.filter(
    (kanban) =>
      kanban.serverId === serverId &&
      !kanban.archivedAt &&
      kanban.orchestrator?.workspaceId === workspaceId,
  );
  if (matches.length === 0) {
    return null;
  }
  return matches.reduce((best, candidate) => (candidate.id < best.id ? candidate : best));
}
