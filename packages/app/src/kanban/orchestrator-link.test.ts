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
    orchestrator: null,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    archivedAt: null,
  };
  return { ...base, serverId: "host-a", serverName: "Host A", ...overrides };
}

describe("resolveOrchestratorKanban", () => {
  it("finds the kanban whose orchestrator runs in the workspace", () => {
    const linked = kanban({
      id: "kanban-2",
      orchestrator: { workspaceId: "ws-1", agentId: "agent-1" },
    });

    const result = resolveOrchestratorKanban({
      kanbans: [kanban(), linked],
      serverId: "host-a",
      workspaceId: "ws-1",
    });

    expect(result).toBe(linked);
  });

  it("ignores links on another host", () => {
    const result = resolveOrchestratorKanban({
      kanbans: [
        kanban({ serverId: "host-b", orchestrator: { workspaceId: "ws-1", agentId: "agent-1" } }),
      ],
      serverId: "host-a",
      workspaceId: "ws-1",
    });

    expect(result).toBeNull();
  });

  it("ignores archived kanbans", () => {
    const result = resolveOrchestratorKanban({
      kanbans: [
        kanban({
          orchestrator: { workspaceId: "ws-1", agentId: "agent-1" },
          archivedAt: "2026-07-02T00:00:00.000Z",
        }),
      ],
      serverId: "host-a",
      workspaceId: "ws-1",
    });

    expect(result).toBeNull();
  });

  it("breaks ties on kanban id so the pane does not follow list order", () => {
    const first = kanban({
      id: "kanban-a",
      orchestrator: { workspaceId: "ws-1", agentId: "agent-1" },
    });
    const second = kanban({
      id: "kanban-b",
      orchestrator: { workspaceId: "ws-1", agentId: "agent-2" },
    });

    expect(
      resolveOrchestratorKanban({
        kanbans: [second, first],
        serverId: "host-a",
        workspaceId: "ws-1",
      }),
    ).toBe(first);
    expect(
      resolveOrchestratorKanban({
        kanbans: [first, second],
        serverId: "host-a",
        workspaceId: "ws-1",
      }),
    ).toBe(first);
  });

  it("returns null without a workspace id", () => {
    const result = resolveOrchestratorKanban({
      kanbans: [kanban({ orchestrator: { workspaceId: "", agentId: "agent-1" } })],
      serverId: "host-a",
      workspaceId: "",
    });

    expect(result).toBeNull();
  });
});
