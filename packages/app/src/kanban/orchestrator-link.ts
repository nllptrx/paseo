import type { OrchestratorPeer } from "@getpaseo/protocol/kanban/rpc-schemas";
import type { AggregatedKanban } from "@/kanban/aggregated-kanbans";

/**
 * Resolves the kanban whose Orchestrator lives in the given workspace.
 *
 * The link is the agent's labels, surfaced as a peer — the board stores nothing,
 * so a workspace whose orchestrator agent is gone resolves to nothing rather than
 * to a kanban that no longer has one. A workspace can in principle host more than
 * one orchestrator agent; ties break on kanban id so the pane stays put across
 * refetches instead of following list order.
 */
export function resolveOrchestratorKanban(input: {
  kanbans: readonly AggregatedKanban[];
  peers: readonly OrchestratorPeer[];
  serverId: string;
  workspaceId: string;
}): AggregatedKanban | null {
  const { kanbans, peers, serverId, workspaceId } = input;
  if (!serverId || !workspaceId) {
    return null;
  }
  const kanbanIds = new Set(
    peers.filter((peer) => peer.workspaceId === workspaceId).map((peer) => peer.kanbanId),
  );
  if (kanbanIds.size === 0) {
    return null;
  }
  const matches = kanbans.filter(
    (kanban) => kanban.serverId === serverId && !kanban.archivedAt && kanbanIds.has(kanban.id),
  );
  if (matches.length === 0) {
    return null;
  }
  return matches.reduce((best, candidate) => (candidate.id < best.id ? candidate : best));
}
