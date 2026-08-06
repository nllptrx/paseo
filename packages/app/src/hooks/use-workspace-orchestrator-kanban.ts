import { useMemo } from "react";
import { useKanbans } from "@/hooks/use-kanbans";
import { useOrchestratorPeers } from "@/hooks/use-orchestrator-peers";
import type { AggregatedKanban } from "@/kanban/aggregated-kanbans";
import { resolveOrchestratorKanban } from "@/kanban/orchestrator-link";

export interface UseWorkspaceOrchestratorKanbanResult {
  kanban: AggregatedKanban | null;
  isLoading: boolean;
}

/**
 * The kanban this workspace orchestrates, or null when it orchestrates nothing.
 *
 * The link lives on the orchestrator agent's labels, surfaced as a peer, so this
 * joins peers against the kanban list instead of being stamped into a tab target
 * — a pane restored after the agent is gone resolves to nothing. Mounting this
 * also registers the kanban push route, so the Orchestrator board reconciles
 * without polling.
 */
export function useWorkspaceOrchestratorKanban(input: {
  serverId: string;
  workspaceId: string;
}): UseWorkspaceOrchestratorKanbanResult {
  const { loadState } = useKanbans();
  const { peers, isLoading: isLoadingPeers } = useOrchestratorPeers();
  const kanban = useMemo(() => {
    if (loadState.status !== "loaded") {
      return null;
    }
    return resolveOrchestratorKanban({
      kanbans: loadState.data,
      peers,
      serverId: input.serverId,
      workspaceId: input.workspaceId,
    });
  }, [input.serverId, input.workspaceId, loadState, peers]);

  return { kanban, isLoading: loadState.status !== "loaded" || isLoadingPeers };
}
