import type { OrchestratorPeer } from "@getpaseo/protocol/kanban/rpc-schemas";
import { describe, expect, it } from "vitest";
import type { AggregatedOrchestratorPeer, OrchestratorPeerRuntime } from "./orchestrator-peers";
import {
  excludeSelfOrchestrator,
  fetchAggregatedOrchestratorPeers,
  resolveOrchestratorPeerBucket,
} from "./orchestrator-peers";

function peer(overrides: Partial<OrchestratorPeer> = {}): OrchestratorPeer {
  return {
    kanbanId: "kanban-1",
    kanbanName: "Board",
    projectId: "project-1",
    workspaceId: "ws-1",
    agentId: "agent-1",
    agentLastStatus: "idle",
    attention: false,
    ...overrides,
  };
}

function aggregated(
  overrides: Partial<AggregatedOrchestratorPeer> = {},
): AggregatedOrchestratorPeer {
  return { ...peer(), serverId: "host-a", serverName: "Host A", ...overrides };
}

function runtime(
  hosts: Record<
    string,
    { online: boolean; peers?: OrchestratorPeer[]; error?: string; throws?: boolean }
  >,
): OrchestratorPeerRuntime {
  return {
    getSnapshot: (serverId) => {
      const host = hosts[serverId];
      return host ? { connectionStatus: host.online ? "online" : "offline" } : null;
    },
    getClient: (serverId) => {
      const host = hosts[serverId];
      if (!host) {
        return null;
      }
      return {
        kanbanOrchestratorListPeers: async () => {
          if (host.throws) {
            throw new Error("socket closed");
          }
          return {
            requestId: "req",
            peers: host.peers ?? [],
            error: host.error ?? null,
          };
        },
      };
    },
  };
}

describe("fetchAggregatedOrchestratorPeers", () => {
  it("merges peers from every connected host and tags them", async () => {
    const result = await fetchAggregatedOrchestratorPeers({
      hosts: [
        { serverId: "host-a", serverName: "Host A" },
        { serverId: "host-b", serverName: "Host B" },
      ],
      runtime: runtime({
        "host-a": { online: true, peers: [peer()] },
        "host-b": { online: true, peers: [peer({ kanbanId: "kanban-2" })] },
      }),
    });

    expect(result.hostErrors).toEqual([]);
    expect(result.peers.map((entry) => [entry.serverId, entry.kanbanId])).toEqual(
      expect.arrayContaining([
        ["host-a", "kanban-1"],
        ["host-b", "kanban-2"],
      ]),
    );
  });

  it("skips offline hosts without reporting an error", async () => {
    const result = await fetchAggregatedOrchestratorPeers({
      hosts: [{ serverId: "host-a", serverName: "Host A" }],
      runtime: runtime({ "host-a": { online: false, peers: [peer()] } }),
    });

    expect(result).toEqual({ peers: [], hostErrors: [] });
  });

  it("records a per-host error and keeps the hosts that answered", async () => {
    const result = await fetchAggregatedOrchestratorPeers({
      hosts: [
        { serverId: "host-a", serverName: "Host A" },
        { serverId: "host-b", serverName: "Host B" },
      ],
      runtime: runtime({
        "host-a": { online: true, throws: true },
        "host-b": { online: true, peers: [peer({ kanbanId: "kanban-2" })] },
      }),
    });

    expect(result.peers.map((entry) => entry.kanbanId)).toEqual(["kanban-2"]);
    expect(result.hostErrors).toEqual([
      { serverId: "host-a", serverName: "Host A", message: "socket closed" },
    ]);
  });

  it("treats a payload error as a host error", async () => {
    const result = await fetchAggregatedOrchestratorPeers({
      hosts: [{ serverId: "host-a", serverName: "Host A" }],
      runtime: runtime({ "host-a": { online: true, error: "kanban store unavailable" } }),
    });

    expect(result.peers).toEqual([]);
    expect(result.hostErrors[0]?.message).toBe("kanban store unavailable");
  });
});

describe("excludeSelfOrchestrator", () => {
  it("drops only the pane's own kanban on its own host", () => {
    const peers = [
      aggregated(),
      aggregated({ kanbanId: "kanban-2" }),
      aggregated({ serverId: "host-b", serverName: "Host B" }),
    ];

    const result = excludeSelfOrchestrator(peers, { serverId: "host-a", kanbanId: "kanban-1" });

    expect(result.map((entry) => [entry.serverId, entry.kanbanId])).toEqual([
      ["host-a", "kanban-2"],
      ["host-b", "kanban-1"],
    ]);
  });
});

describe("resolveOrchestratorPeerBucket", () => {
  it("prefers the live workspace bucket over the listing snapshot", () => {
    const bucket = resolveOrchestratorPeerBucket({
      liveBucket: "running",
      agentLastStatus: "idle",
      attention: false,
    });

    expect(bucket).toBe("running");
  });

  it("derives from the listing snapshot when no live bucket is held", () => {
    expect(
      resolveOrchestratorPeerBucket({
        liveBucket: null,
        agentLastStatus: "running",
        attention: false,
      }),
    ).toBe("running");
    expect(
      resolveOrchestratorPeerBucket({
        liveBucket: null,
        agentLastStatus: "error",
        attention: false,
      }),
    ).toBe("failed");
    expect(
      resolveOrchestratorPeerBucket({ liveBucket: null, agentLastStatus: "idle", attention: true }),
    ).toBe("attention");
  });

  it("falls back to attention or done for an unknown status", () => {
    expect(
      resolveOrchestratorPeerBucket({ liveBucket: null, agentLastStatus: null, attention: true }),
    ).toBe("attention");
    expect(
      resolveOrchestratorPeerBucket({
        liveBucket: undefined,
        agentLastStatus: "who-knows",
        attention: false,
      }),
    ).toBe("done");
  });
});
