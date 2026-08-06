import { useMemo } from "react";
import { useKanbans } from "@/hooks/use-kanbans";
import type { AggregatedKanban } from "@/kanban/aggregated-kanbans";
import { resolveOrchestratorKanban } from "@/kanban/orchestrator-link";

export interface UseWorkspaceOrchestratorKanbanResult {
  kanban: AggregatedKanban | null;
  isLoading: boolean;
}

/**
 * The kanban this workspace orchestrates, or null when it orchestrates nothing.
 *
 * The link lives on the kanban (`orchestrator.workspaceId`), so this joins over
 * the kanban list instead of being stamped into a tab target — a pane restored
 * after an unlink resolves to nothing rather than to a kanban that no longer
 * claims the workspace. Mounting this also registers the kanban push route, so
 * the Orchestrator board reconciles without polling.
 */
export function useWorkspaceOrchestratorKanban(input: {
  serverId: string;
  workspaceId: string;
}): UseWorkspaceOrchestratorKanbanResult {
  const { loadState } = useKanbans();
  const kanban = useMemo(() => {
    if (loadState.status !== "loaded") {
      return null;
    }
    return resolveOrchestratorKanban({
      kanbans: loadState.data,
      serverId: input.serverId,
      workspaceId: input.workspaceId,
    });
  }, [input.serverId, input.workspaceId, loadState]);

  return { kanban, isLoading: loadState.status !== "loaded" };
}
