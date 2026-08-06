import { useMemo } from "react";
import type { StoredKanban } from "@getpaseo/protocol/kanban/types";
import { useFetchQuery } from "@/data/query";
import { kanbanPushRoute } from "@/data/push-router";
import {
  getHostRuntimeStore,
  useHostRuntimeConnectionStatuses,
  useHostRuntimeClient,
  useHostRuntimeIsConnected,
  useHosts,
} from "@/runtime/host-runtime";
import {
  fetchAggregatedKanbans,
  kanbanQueryKey,
  kanbansQueryBaseKey,
  type AggregateLoadState,
  type AggregatedKanban,
  type KanbanHostError,
  type KanbanHostInput,
} from "@/kanban/aggregated-kanbans";

export type {
  AggregateLoadState,
  AggregatedKanban,
  KanbanHostError,
} from "@/kanban/aggregated-kanbans";

export function kanbansQueryKey(serverIds: readonly string[]) {
  return [...kanbansQueryBaseKey, [...serverIds].sort().join("|")] as const;
}

export interface UseKanbansResult {
  loadState: AggregateLoadState<AggregatedKanban>;
  hostErrors: KanbanHostError[];
  isError: boolean;
  error: Error | null;
  refetch: () => void;
  isRefetching: boolean;
}

export function useKanbans(): UseKanbansResult {
  const hosts = useHosts();
  const runtime = getHostRuntimeStore();
  const hostInputs = useMemo<KanbanHostInput[]>(
    () => hosts.map((host) => ({ serverId: host.serverId, serverName: host.label })),
    [hosts],
  );
  const serverIds = useMemo(() => hostInputs.map((host) => host.serverId), [hostInputs]);
  const connectionStatuses = useHostRuntimeConnectionStatuses(serverIds);
  const connectionStatusKey = useMemo(
    () => serverIds.map((serverId) => connectionStatuses.get(serverId) ?? "connecting").join("|"),
    [connectionStatuses, serverIds],
  );

  const query = useFetchQuery({
    queryKey: [...kanbansQueryKey(serverIds), connectionStatusKey],
    queryFn: () => fetchAggregatedKanbans({ hosts: hostInputs, runtime }),
    dataShape: "list",
    staleTimeMs: 5_000,
    meta: kanbanPushRoute({ enabled: serverIds.length > 0, serverIds }),
  });

  let loadState: AggregateLoadState<AggregatedKanban>;
  if (query.data?.status === "connecting") {
    loadState = { status: "connecting" };
  } else if (query.data?.status === "loaded") {
    loadState = { status: "loaded", data: query.data.data };
  } else {
    loadState = { status: "loading" };
  }

  return {
    loadState,
    hostErrors: query.data?.status === "loaded" ? query.data.hostErrors : [],
    isError: query.isError,
    error: query.error,
    refetch: () => {
      void query.refetch();
    },
    isRefetching: query.isRefetching,
  };
}

export interface UseKanbanResult {
  kanban: StoredKanban | null;
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  refetch: () => void;
}

export function useKanban(input: {
  serverId: string;
  kanbanId: string;
  enabled?: boolean;
}): UseKanbanResult {
  const { serverId, kanbanId, enabled = true } = input;
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const queryEnabled = enabled && Boolean(client) && isConnected && Boolean(kanbanId);

  const query = useFetchQuery({
    queryKey: kanbanQueryKey(serverId, kanbanId),
    queryFn: async (): Promise<StoredKanban | null> => {
      if (!client) {
        throw new Error("Host disconnected");
      }
      const payload = await client.kanbanGet(kanbanId);
      if (payload.error) {
        throw new Error(payload.error);
      }
      return payload.kanban;
    },
    enabled: queryEnabled,
    dataShape: "value",
    staleTimeMs: 5_000,
  });

  return {
    kanban: query.data ?? null,
    isLoading: queryEnabled && query.isPending,
    isError: query.isError,
    error: query.error,
    refetch: () => {
      void query.refetch();
    },
  };
}
