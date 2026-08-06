import { useMemo } from "react";
import { useFetchQuery } from "@/data/query";
import { kanbanPushRoute } from "@/data/push-router";
import { getHostRuntimeStore, useHosts } from "@/runtime/host-runtime";
import { useHostFeatureMap } from "@/runtime/host-features";
import {
  fetchSidebarKanbanIndex,
  sidebarKanbanIndexQueryKey,
  type SidebarKanbanIndex,
} from "./sidebar-kanban-index";
import type { KanbanColumnRef } from "./sidebar-kanban-view-model";

const EMPTY_COLUMN_REFS = new Map<string, KanbanColumnRef>();

/**
 * The column each kanban-tracked workspace's card sits in, across every connected host that
 * reports the `kanban` feature. Only fetches while `enabled` — the sidebar only needs this in
 * Kanban grouping mode, and a default user with the feature off never asks.
 */
export function useSidebarKanbanIndex(options?: { enabled?: boolean }): {
  columnRefByWorkspaceKey: ReadonlyMap<string, KanbanColumnRef>;
  isLoading: boolean;
} {
  const runtime = getHostRuntimeStore();
  const hosts = useHosts();
  const serverIds = useMemo(() => hosts.map((host) => host.serverId), [hosts]);
  const kanbanFeatureByServerId = useHostFeatureMap(serverIds, "kanban");
  const kanbanServerIds = useMemo(
    () => serverIds.filter((serverId) => kanbanFeatureByServerId.get(serverId) === true),
    [serverIds, kanbanFeatureByServerId],
  );
  const enabled = options?.enabled !== false && kanbanServerIds.length > 0;

  const query = useFetchQuery({
    queryKey: sidebarKanbanIndexQueryKey(kanbanServerIds),
    queryFn: () => fetchSidebarKanbanIndex({ serverIds: kanbanServerIds, runtime }),
    dataShape: "value",
    staleTimeMs: 10_000,
    enabled,
    meta: kanbanPushRoute({ enabled, serverIds: kanbanServerIds }),
  });

  const data: SidebarKanbanIndex | undefined = query.data;

  return {
    columnRefByWorkspaceKey: data?.columnRefByWorkspaceKey ?? EMPTY_COLUMN_REFS,
    isLoading: enabled && query.isLoading,
  };
}
