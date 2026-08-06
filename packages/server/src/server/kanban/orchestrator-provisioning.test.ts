import { describe, expect, test } from "vitest";
import pino from "pino";
import { provisionKanbanOrchestrator } from "./orchestrator-provisioning.js";
import type { KanbanService } from "./service.js";

function testLogger() {
  return pino({ level: "silent" });
}

function fakeKanban(overrides: { orchestrator?: unknown; archivedAt?: string | null } = {}) {
  return {
    id: "kbn_1",
    projectId: "proj-1",
    name: "Board",
    orchestrator: overrides.orchestrator ?? null,
    archivedAt: overrides.archivedAt ?? null,
  } as never;
}

describe("provisionKanbanOrchestrator", () => {
  test("rolls back the workspace when stamping the pointer fails after creation", async () => {
    let archivedWorkspaceId: string | null = null;
    const kanbanService = {
      get: async () => fakeKanban(),
      provisionOrchestratorPointer: async () => {
        throw new Error("race: pointer already claimed");
      },
    } as unknown as KanbanService;

    await expect(
      provisionKanbanOrchestrator(
        {
          kanbanService,
          logger: testLogger(),
          projectRegistry: { get: async () => ({ rootPath: "/tmp/project-root" }) as never },
          createDirectoryWorkspace: async () => ({ workspaceId: "ws-new", cwd: "/tmp" }) as never,
          createAgent: async () => ({
            snapshot: { id: "agent-new" } as never,
            liveSnapshot: { id: "agent-new" } as never,
            background: true,
            initialPromptStarted: false,
            initialPromptError: null,
          }),
          resolveDefaultProvider: async () => "claude",
          archiveWorkspace: async (workspaceId) => {
            archivedWorkspaceId = workspaceId;
          },
        },
        "kbn_1",
      ),
    ).rejects.toThrow(/race: pointer already claimed/);

    expect(archivedWorkspaceId).toBe("ws-new");
  });

  test("fails fast without creating a workspace when the kanban already has an orchestrator", async () => {
    let createdWorkspace = false;
    const kanbanService = {
      get: async () => fakeKanban({ orchestrator: { workspaceId: "ws-1", agentId: "agent-1" } }),
    } as unknown as KanbanService;

    await expect(
      provisionKanbanOrchestrator(
        {
          kanbanService,
          logger: testLogger(),
          projectRegistry: { get: async () => ({ rootPath: "/tmp/project-root" }) as never },
          createDirectoryWorkspace: async () => {
            createdWorkspace = true;
            return { workspaceId: "ws-2", cwd: "/tmp" } as never;
          },
          createAgent: async () => {
            throw new Error("should not be called");
          },
          resolveDefaultProvider: async () => "claude",
          archiveWorkspace: async () => {},
        },
        "kbn_1",
      ),
    ).rejects.toThrow(/already has an orchestrator/);

    expect(createdWorkspace).toBe(false);
  });

  test("throws when the kanban's project cannot be found", async () => {
    const kanbanService = {
      get: async () => fakeKanban(),
    } as unknown as KanbanService;

    await expect(
      provisionKanbanOrchestrator(
        {
          kanbanService,
          logger: testLogger(),
          projectRegistry: { get: async () => null },
          createDirectoryWorkspace: async () => ({ workspaceId: "ws-2", cwd: "/tmp" }) as never,
          createAgent: async () => {
            throw new Error("should not be called");
          },
          resolveDefaultProvider: async () => "claude",
          archiveWorkspace: async () => {},
        },
        "kbn_1",
      ),
    ).rejects.toThrow(/Project not found/);
  });
});
