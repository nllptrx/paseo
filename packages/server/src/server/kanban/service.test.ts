import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import pino from "pino";
import { KanbanStore } from "./store.js";
import { KanbanService } from "./service.js";

function testLogger() {
  return pino({ level: "silent" });
}

describe("KanbanService orchestrator methods", () => {
  let tempDir: string;
  let store: KanbanStore;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "kanban-service-test-"));
    store = new KanbanStore(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("provisionOrchestratorPointer stamps the pointer and rejects a second one", async () => {
    const service = new KanbanService({ store, logger: testLogger() });
    const kanban = await service.getOrCreateForProject("proj-1");

    const updated = await service.provisionOrchestratorPointer(kanban.id, {
      workspaceId: "ws-1",
      agentId: "agent-1",
    });
    expect(updated.orchestrator).toEqual({ workspaceId: "ws-1", agentId: "agent-1" });

    await expect(
      service.provisionOrchestratorPointer(kanban.id, {
        workspaceId: "ws-2",
        agentId: "agent-2",
      }),
    ).rejects.toThrow(/already has an orchestrator/);
  });

  test("unlinkOrchestrator clears the pointer only", async () => {
    const service = new KanbanService({ store, logger: testLogger() });
    const kanban = await service.getOrCreateForProject("proj-1");
    await service.provisionOrchestratorPointer(kanban.id, {
      workspaceId: "ws-1",
      agentId: "agent-1",
    });

    const updated = await service.unlinkOrchestrator(kanban.id);
    expect(updated.orchestrator).toBeNull();
  });

  test("listOrchestratorPeers joins live agent state when the agent is loaded", async () => {
    const service = new KanbanService({
      store,
      logger: testLogger(),
      agentManager: {
        getAgent: (agentId: string) =>
          agentId === "agent-1"
            ? ({
                lifecycle: "running",
                attention: { requiresAttention: true, attentionReason: "permission" },
              } as never)
            : null,
      },
      agentStorage: {
        get: async () => null,
      },
    });
    const kanban = await service.getOrCreateForProject("proj-1", { name: "Board" });
    await service.provisionOrchestratorPointer(kanban.id, {
      workspaceId: "ws-1",
      agentId: "agent-1",
    });

    const peers = await service.listOrchestratorPeers();
    expect(peers).toEqual([
      {
        kanbanId: kanban.id,
        kanbanName: "Board",
        projectId: "proj-1",
        workspaceId: "ws-1",
        agentId: "agent-1",
        agentLastStatus: "running",
        attention: true,
      },
    ]);
  });

  test("listOrchestratorPeers falls back to persisted status when the agent isn't loaded", async () => {
    const service = new KanbanService({
      store,
      logger: testLogger(),
      agentManager: { getAgent: () => null },
      agentStorage: {
        get: async () => ({ lastStatus: "idle", attentionReason: null }) as never,
      },
    });
    const kanban = await service.getOrCreateForProject("proj-1");
    await service.provisionOrchestratorPointer(kanban.id, {
      workspaceId: "ws-1",
      agentId: "agent-1",
    });

    const peers = await service.listOrchestratorPeers();
    expect(peers).toEqual([expect.objectContaining({ agentLastStatus: "idle", attention: false })]);
  });

  test("listOrchestratorPeers skips archived kanbans and kanbans without an orchestrator", async () => {
    const service = new KanbanService({ store, logger: testLogger() });
    await service.getOrCreateForProject("proj-no-orchestrator");
    const archived = await service.getOrCreateForProject("proj-archived");
    await service.provisionOrchestratorPointer(archived.id, {
      workspaceId: "ws-1",
      agentId: "agent-1",
    });
    await service.archive(archived.id);

    expect(await service.listOrchestratorPeers()).toEqual([]);
  });

  test("getPlan resolves top-level and nested plans", async () => {
    const service = new KanbanService({ store, logger: testLogger() });
    const kanban = await service.getOrCreateForProject("proj-1");
    const columnId = kanban.columns[0].id;
    const topPlan = await service.createPlan({
      kanbanId: kanban.id,
      columnId,
      title: "Nested board",
      body: { type: "nested_kanban" },
    });
    if (topPlan.body.type !== "nested_kanban") throw new Error("expected nested_kanban");
    const nestedColumnId = topPlan.body.columns[0].id;
    const nestedPlan = await service.createPlan({
      kanbanId: kanban.id,
      parentPlanId: topPlan.id,
      columnId: nestedColumnId,
      title: "Nested workflow",
      body: { type: "workflow", steps: [] },
    });

    await expect(service.getPlan(kanban.id, topPlan.id)).resolves.toMatchObject({
      id: topPlan.id,
    });
    await expect(service.getPlan(kanban.id, nestedPlan.id, topPlan.id)).resolves.toMatchObject({
      id: nestedPlan.id,
    });
    await expect(service.getPlan(kanban.id, "missing")).rejects.toThrow(/Plan not found/);
  });
});
