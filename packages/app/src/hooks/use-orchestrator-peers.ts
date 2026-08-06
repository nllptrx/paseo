import { useMemo } from "react";
import { useFetchQuery } from "@/data/query";
import {
  fetchAggregatedOrchestratorPeers,
  orchestratorPeersQueryKey,
  type AggregatedOrchestratorPeer,
  type OrchestratorPeerHostError,
  type OrchestratorPeerHostInput,
} from "@/kanban/orchestrator-peers";
import {
  getHostRuntimeStore,
  useHostRuntimeConnectionStatuses,
  useHosts,
} from "@/runtime/host-runtime";

export interface UseOrchestratorPeersResult {
  peers: AggregatedOrchestratorPeer[];
  hostErrors: OrchestratorPeerHostError[];
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  refetch: () => void;
}

const EMPTY_PEERS: AggregatedOrchestratorPeer[] = [];
const EMPTY_HOST_ERRORS: OrchestratorPeerHostError[] = [];

/**
 * Lists the Orchestrators reachable from this client, across every connected
 * host. There is no push channel for the peer join, so this refetches on mount
 * and whenever the connected host set changes.
 */
export function useOrchestratorPeers(options?: { enabled?: boolean }): UseOrchestratorPeersResult {
  const enabled = options?.enabled ?? true;
  const hosts = useHosts();
  const runtime = getHostRuntimeStore();
  const hostInputs = useMemo<OrchestratorPeerHostInput[]>(
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
    queryKey: [...orchestratorPeersQueryKey(serverIds), connectionStatusKey],
    queryFn: () => fetchAggregatedOrchestratorPeers({ hosts: hostInputs, runtime }),
    enabled: enabled && serverIds.length > 0,
    dataShape: "list",
    staleTimeMs: 5_000,
  });

  return {
    peers: query.data?.peers ?? EMPTY_PEERS,
    hostErrors: query.data?.hostErrors ?? EMPTY_HOST_ERRORS,
    isLoading: enabled && serverIds.length > 0 && query.isPending,
    isError: query.isError,
    error: query.error,
    refetch: () => {
      void query.refetch();
    },
  };
}
