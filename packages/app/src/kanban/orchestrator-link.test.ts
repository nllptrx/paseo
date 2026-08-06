import type { OrchestratorPeer } from "@getpaseo/protocol/kanban/rpc-schemas";
import type { KanbanSummary } from "@getpaseo/protocol/kanban/types";
import { describe, expect, it } from "vitest";
import type { AggregatedKanban } from "./aggregated-kanbans";
import { resolveOrchestratorKanban } from "./orchestrator-link";

function kanban(overrides: Partial<AggregatedKanban> = {}): AggregatedKanban {
  const base: KanbanSummary = {
    id: "kanban-1",
    projectId: "project-1",
    name: "Board",
    archiveWorkspacesOnDone: false,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    archivedAt: null,
  };
  return { ...base, serverId: "host-a", serverName: "Host A", ...overrides };
}

function peer(overrides: Partial<OrchestratorPeer> = {}): OrchestratorPeer {
  return {
    kanbanId: "kanban-1",
    kanbanName: "Board",
    projectId: "project-1",
    workspaceId: "ws-1",
    agentId: "agent-1",
    agentTitle: "Board Orchestrator",
    agentLastStatus: "idle",
    attention: false,
    ...overrides,
  };
}

describe("resolveOrchestratorKanban", () => {
  it("finds the kanban whose orchestrator agent runs in the workspace", () => {
    const linked = kanban({ id: "kanban-2" });

    const result = resolveOrchestratorKanban({
      kanbans: [kanban(), linked],
      peers: [peer({ kanbanId: "kanban-2", workspaceId: "ws-1" })],
      serverId: "host-a",
      workspaceId: "ws-1",
    });

    expect(result).toBe(linked);
  });

  it("ignores links on another host", () => {
    const result = resolveOrchestratorKanban({
      kanbans: [kanban({ serverId: "host-b" })],
      peers: [peer({ workspaceId: "ws-1" })],
      serverId: "host-a",
      workspaceId: "ws-1",
    });

    expect(result).toBeNull();
  });

  it("ignores archived kanbans", () => {
    const result = resolveOrchestratorKanban({
      kanbans: [kanban({ archivedAt: "2026-07-02T00:00:00.000Z" })],
      peers: [peer({ workspaceId: "ws-1" })],
      serverId: "host-a",
      workspaceId: "ws-1",
    });

    expect(result).toBeNull();
  });

  it("resolves to nothing once the workspace hosts no orchestrator agent", () => {
    const result = resolveOrchestratorKanban({
      kanbans: [kanban()],
      peers: [],
      serverId: "host-a",
      workspaceId: "ws-1",
    });

    expect(result).toBeNull();
  });

  it("breaks ties on kanban id so the pane does not follow list order", () => {
    const first = kanban({ id: "kanban-a" });
    const second = kanban({ id: "kanban-b" });
    const peers = [
      peer({ kanbanId: "kanban-a", workspaceId: "ws-1", agentId: "agent-1" }),
      peer({ kanbanId: "kanban-b", workspaceId: "ws-1", agentId: "agent-2" }),
    ];

    expect(
      resolveOrchestratorKanban({
        kanbans: [second, first],
        peers,
        serverId: "host-a",
        workspaceId: "ws-1",
      }),
    ).toBe(first);
    expect(
      resolveOrchestratorKanban({
        kanbans: [first, second],
        peers,
        serverId: "host-a",
        workspaceId: "ws-1",
      }),
    ).toBe(first);
  });

  it("keeps every orchestrator of one kanban pointing at that kanban", () => {
    const board = kanban({ id: "kanban-1" });
    const peers = [
      peer({ workspaceId: "ws-1", agentId: "agent-1" }),
      peer({ workspaceId: "ws-2", agentId: "agent-2" }),
    ];

    expect(
      resolveOrchestratorKanban({
        kanbans: [board],
        peers,
        serverId: "host-a",
        workspaceId: "ws-2",
      }),
    ).toBe(board);
  });

  it("returns null without a workspace id", () => {
    const result = resolveOrchestratorKanban({
      kanbans: [kanban()],
      peers: [peer({ workspaceId: "" })],
      serverId: "host-a",
      workspaceId: "",
    });

    expect(result).toBeNull();
  });
});
