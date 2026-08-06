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

describe("KanbanService list", () => {
  let tempDir: string;
  let store: KanbanStore;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "kanban-service-list-test-"));
    store = new KanbanStore(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("omits archived kanbans so archiving clears them from every board surface", async () => {
    const service = new KanbanService({ store, logger: testLogger() });
    const kept = await service.getOrCreateForProject("proj-kept");
    const archived = await service.getOrCreateForProject("proj-archived");
    await service.archive(archived.id);

    const listed = await service.list();

    expect(listed.map((kanban) => kanban.id)).toEqual([kept.id]);
    // Still readable by id: archiving hides it, it does not delete it.
    expect(await service.get(archived.id)).not.toBeNull();
  });
});

describe("KanbanService orchestrator listing", () => {
  let tempDir: string;
  let store: KanbanStore;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "kanban-orchestrator-test-"));
    store = new KanbanStore(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  function orchestratorAgent(overrides: {
    id: string;
    kanbanId: string;
    workspaceId?: string;
    title?: string | null;
  }) {
    return {
      id: overrides.id,
      workspaceId: overrides.workspaceId ?? "ws-1",
      title: overrides.title ?? null,
      labels: { "paseo.kanban-orchestrator": "true", "paseo.kanban-id": overrides.kanbanId },
      lastStatus: "idle",
    };
  }

  test("joins live agent state when the agent is loaded", async () => {
    const kanban = await new KanbanService({ store, logger: testLogger() }).getOrCreateForProject(
      "proj-1",
      { name: "Board" },
    );
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
        list: async () =>
          [
            orchestratorAgent({ id: "agent-1", kanbanId: kanban.id, title: "Board Orchestrator" }),
          ] as never,
      },
    });

    expect(await service.listOrchestratorPeers()).toEqual([
      {
        kanbanId: kanban.id,
        kanbanName: "Board",
        projectId: "proj-1",
        workspaceId: "ws-1",
        agentId: "agent-1",
        agentTitle: "Board Orchestrator",
        agentLastStatus: "running",
        attention: true,
      },
    ]);
  });

  test("falls back to persisted status when the agent isn't loaded", async () => {
    const kanban = await new KanbanService({ store, logger: testLogger() }).getOrCreateForProject(
      "proj-1",
    );
    const service = new KanbanService({
      store,
      logger: testLogger(),
      agentManager: { getAgent: () => null },
      agentStorage: {
        get: async () => ({ lastStatus: "idle", attentionReason: null }) as never,
        list: async () => [orchestratorAgent({ id: "agent-1", kanbanId: kanban.id })] as never,
      },
    });

    expect(await service.listOrchestratorPeers()).toEqual([
      expect.objectContaining({ agentLastStatus: "idle", attention: false }),
    ]);
  });

  test("reports every orchestrator a kanban has, not just the first", async () => {
    const kanban = await new KanbanService({ store, logger: testLogger() }).getOrCreateForProject(
      "proj-1",
    );
    const service = new KanbanService({
      store,
      logger: testLogger(),
      agentManager: { getAgent: () => null },
      agentStorage: {
        get: async () => null,
        list: async () =>
          [
            orchestratorAgent({ id: "agent-1", kanbanId: kanban.id, workspaceId: "ws-1" }),
            orchestratorAgent({ id: "agent-2", kanbanId: kanban.id, workspaceId: "ws-2" }),
          ] as never,
      },
    });

    const peers = await service.listOrchestrators(kanban.id);
    expect(peers.map((peer) => peer.agentId)).toEqual(["agent-1", "agent-2"]);
  });

  test("skips agents without the labels and agents whose kanban is archived", async () => {
    const bootstrap = new KanbanService({ store, logger: testLogger() });
    const archived = await bootstrap.getOrCreateForProject("proj-archived");
    await bootstrap.archive(archived.id);
    const service = new KanbanService({
      store,
      logger: testLogger(),
      agentManager: { getAgent: () => null },
      agentStorage: {
        get: async () => null,
        list: async () =>
          [
            orchestratorAgent({ id: "agent-archived", kanbanId: archived.id }),
            { id: "agent-plain", workspaceId: "ws-9", title: null, labels: {}, lastStatus: "idle" },
          ] as never,
      },
    });

    expect(await service.listOrchestratorPeers()).toEqual([]);
  });
});

describe("KanbanService plans", () => {
  let tempDir: string;
  let store: KanbanStore;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "kanban-plans-test-"));
    store = new KanbanStore(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("getPlan resolves top-level and nested plans", async () => {
    const service = new KanbanService({ store, logger: testLogger() });
    const kanban = await service.getOrCreateForProject("proj-1");
    const topPlan = await service.createPlan({
      kanbanId: kanban.id,
      title: "Nested board",
      body: { type: "nested_kanban" },
    });
    if (topPlan.body.type !== "nested_kanban") throw new Error("expected nested_kanban");
    const nestedPlan = await service.createPlan({
      kanbanId: kanban.id,
      parentPlanId: topPlan.id,
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
