import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { AGENT_LIFECYCLE_STATUSES } from "@getpaseo/protocol/agent-lifecycle";
import type { AgentLifecycleStatus } from "@getpaseo/protocol/agent-lifecycle";
import type { OrchestratorPeer } from "@getpaseo/protocol/kanban/rpc-schemas";
import { deriveSidebarStateBucket, type SidebarStateBucket } from "@/utils/sidebar-agent-state";
import { toErrorMessage } from "@/utils/error-messages";

export const orchestratorPeersQueryBaseKey = ["orchestrator-peers"] as const;

export function orchestratorPeersQueryKey(serverIds: readonly string[]) {
  return [...orchestratorPeersQueryBaseKey, [...serverIds].sort().join("|")] as const;
}

/** An Orchestrator tagged with the host that reported it, so a row can carry a
 * host badge and route its chat post back to the right daemon. */
export interface AggregatedOrchestratorPeer extends OrchestratorPeer {
  serverId: string;
  serverName: string;
}

export interface OrchestratorPeerHostInput {
  serverId: string;
  serverName: string;
}

export interface OrchestratorPeerHostError {
  serverId: string;
  serverName: string;
  message: string;
}

export interface OrchestratorPeerRuntime {
  getClient(serverId: string): Pick<DaemonClient, "kanbanOrchestratorListPeers"> | null;
  getSnapshot(serverId: string): { connectionStatus: string } | null | undefined;
}

export interface FetchOrchestratorPeersResult {
  peers: AggregatedOrchestratorPeer[];
  hostErrors: OrchestratorPeerHostError[];
}

/**
 * Asks every connected host for its Orchestrators and merges the answers into
 * one list. Offline hosts are skipped; a connected host that fails contributes
 * to `hostErrors` so the rail still renders the hosts that answered.
 */
export async function fetchAggregatedOrchestratorPeers(input: {
  hosts: readonly OrchestratorPeerHostInput[];
  runtime: OrchestratorPeerRuntime;
}): Promise<FetchOrchestratorPeersResult> {
  const peers: AggregatedOrchestratorPeer[] = [];
  const hostErrors: OrchestratorPeerHostError[] = [];

  await Promise.all(
    input.hosts.map(async (host) => {
      const snapshot = input.runtime.getSnapshot(host.serverId);
      const client = input.runtime.getClient(host.serverId);
      if (!client || snapshot?.connectionStatus !== "online") {
        return;
      }
      try {
        const payload = await client.kanbanOrchestratorListPeers();
        if (payload.error) {
          throw new Error(payload.error);
        }
        for (const peer of payload.peers) {
          peers.push({ ...peer, serverId: host.serverId, serverName: host.serverName });
        }
      } catch (error) {
        hostErrors.push({
          serverId: host.serverId,
          serverName: host.serverName,
          message: toErrorMessage(error),
        });
      }
    }),
  );

  return { peers, hostErrors };
}

/**
 * The bucket a rail row shows. The workspace bucket the client already holds is
 * push-fed and therefore fresher than the snapshot the peer listing returned, so
 * it wins whenever the host's workspaces have hydrated.
 */
export function resolveOrchestratorPeerBucket(input: {
  liveBucket: SidebarStateBucket | null | undefined;
  agentLastStatus: string | null;
  attention: boolean;
}): SidebarStateBucket {
  if (input.liveBucket) {
    return input.liveBucket;
  }
  const status = toAgentLifecycleStatus(input.agentLastStatus);
  if (!status) {
    return input.attention ? "attention" : "done";
  }
  return deriveSidebarStateBucket({ status, requiresAttention: input.attention });
}

function toAgentLifecycleStatus(value: string | null): AgentLifecycleStatus | null {
  return AGENT_LIFECYCLE_STATUSES.find((status) => status === value) ?? null;
}

/** Drops the Orchestrator the pane itself belongs to — the rail only lists the others. */
export function excludeSelfOrchestrator(
  peers: readonly AggregatedOrchestratorPeer[],
  self: { serverId: string; kanbanId: string },
): AggregatedOrchestratorPeer[] {
  return peers.filter(
    (peer) => !(peer.serverId === self.serverId && peer.kanbanId === self.kanbanId),
  );
}
