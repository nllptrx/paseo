import { describe, expect, test } from "vitest";
import pino from "pino";
import { provisionKanbanOrchestrator } from "./orchestrator-provisioning.js";
import type { KanbanService } from "./service.js";

function testLogger() {
  return pino({ level: "silent" });
}

function fakeKanban(overrides: { archivedAt?: string | null } = {}) {
  return {
    id: "kbn_1",
    projectId: "proj-1",
    name: "Board",
    plans: {},
    archivedAt: overrides.archivedAt ?? null,
  } as never;
}

describe("provisionKanbanOrchestrator", () => {
  test("rolls back the workspace when the agent fails to come up", async () => {
    let archivedWorkspaceId: string | null = null;
    const kanbanService = {
      get: async () => fakeKanban(),
      listOrchestrators: async () => [],
    } as unknown as KanbanService;

    await expect(
      provisionKanbanOrchestrator(
        {
          kanbanService,
          logger: testLogger(),
          projectRegistry: { get: async () => ({ rootPath: "/tmp/project-root" }) as never },
          createDirectoryWorkspace: async () => ({ workspaceId: "ws-new", cwd: "/tmp" }) as never,
          createAgent: async () => {
            throw new Error("provider unavailable");
          },
          resolveDefaultProvider: async () => "claude",
          archiveWorkspace: async (workspaceId) => {
            archivedWorkspaceId = workspaceId;
          },
        },
        "kbn_1",
      ),
    ).rejects.toThrow(/provider unavailable/);

    expect(archivedWorkspaceId).toBe("ws-new");
  });

  test("a kanban may have several orchestrators, and later ones get numbered titles", async () => {
    const titles: string[] = [];
    const kanbanService = {
      get: async () => fakeKanban(),
      listOrchestrators: async () => [{ agentId: "agent-1" }] as never,
    } as unknown as KanbanService;

    await provisionKanbanOrchestrator(
      {
        kanbanService,
        logger: testLogger(),
        projectRegistry: { get: async () => ({ rootPath: "/tmp/project-root" }) as never },
        createDirectoryWorkspace: async (_cwd, title) => {
          titles.push(title ?? "");
          return { workspaceId: "ws-new", cwd: "/tmp" } as never;
        },
        createAgent: async () => ({
          snapshot: { id: "agent-2" } as never,
          liveSnapshot: { id: "agent-2" } as never,
          background: true,
          initialPromptStarted: true,
          initialPromptError: null,
        }),
        resolveDefaultProvider: async () => "claude",
        archiveWorkspace: async () => {},
      },
      "kbn_1",
    );

    expect(titles).toEqual(["Board Orchestrator 2"]);
  });

  test("briefs the agent on the board it steers instead of leaving it to guess", async () => {
    let initialPrompt: string | undefined;
    const kanbanService = {
      get: async () => fakeKanban(),
      listOrchestrators: async () => [],
    } as unknown as KanbanService;

    await provisionKanbanOrchestrator(
      {
        kanbanService,
        logger: testLogger(),
        projectRegistry: { get: async () => ({ rootPath: "/tmp/project-root" }) as never },
        createDirectoryWorkspace: async () => ({ workspaceId: "ws-new", cwd: "/tmp" }) as never,
        createAgent: async (input) => {
          initialPrompt = input.initialPrompt;
          return {
            snapshot: { id: "agent-1" } as never,
            liveSnapshot: { id: "agent-1" } as never,
            background: true,
            initialPromptStarted: true,
            initialPromptError: null,
          };
        },
        resolveDefaultProvider: async () => "claude",
        archiveWorkspace: async () => {},
      },
      "kbn_1",
    );

    expect(initialPrompt).toContain("kbn_1");
    expect(initialPrompt).toContain("run_plan");
    // The failure this guards: an agent that answers board questions by grepping.
    expect(initialPrompt).toMatch(/never answer questions about the board by searching/i);
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
