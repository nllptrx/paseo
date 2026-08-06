import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import pino from "pino";
import type { SessionOutboundMessage } from "../../messages.js";
import { KanbanStore } from "../../kanban/store.js";
import { KanbanService } from "../../kanban/service.js";
import { KanbanSession } from "./kanban-session.js";

function testLogger() {
  return pino({ level: "silent" });
}

describe("KanbanSession orchestrator provisioning", () => {
  let tempDir: string;
  let store: KanbanStore;
  let kanbanService: KanbanService;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "kanban-session-test-"));
    store = new KanbanStore(tempDir);
    kanbanService = new KanbanService({ store, logger: testLogger() });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("provisions a workspace + agent + pointer atomically", async () => {
    const kanban = await kanbanService.getOrCreateForProject("proj-1", { name: "Board" });
    const emitted: SessionOutboundMessage[] = [];
    let archiveCalls = 0;

    const session = new KanbanSession({
      host: { emit: (msg) => emitted.push(msg) },
      kanbanService,
      logger: testLogger(),
      orchestratorProvisioning: {
        projectRegistry: { get: async () => ({ rootPath: "/tmp/project-root" }) as never },
        createDirectoryWorkspace: async (cwd, title, projectId) => ({
          workspaceId: "ws-1",
          projectId: projectId ?? "proj-1",
          cwd,
          kind: "directory",
          displayName: title ?? "Orchestrator",
          title: title ?? null,
          branch: null,
          worktreeRoot: null,
          baseBranch: null,
          isPaseoOwnedWorktree: false,
          mainRepoRoot: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          archivedAt: null,
          autoArchivedChangeRequestUrl: null,
          pinnedAt: null,
        }),
        createAgent: async () => ({
          snapshot: { id: "agent-1" } as never,
          liveSnapshot: { id: "agent-1" } as never,
          background: true,
          initialPromptStarted: false,
          initialPromptError: null,
        }),
        resolveDefaultProvider: async () => "claude",
        archiveWorkspace: async () => {
          archiveCalls += 1;
        },
      },
    });

    await session.handleOrchestratorProvisionRequest({
      type: "kanban.orchestrator.provision.request",
      requestId: "req-1",
      kanbanId: kanban.id,
    });

    expect(archiveCalls).toBe(0);
    const response = emitted.find((msg) => msg.type === "kanban.orchestrator.provision.response");
    expect(response).toMatchObject({
      payload: {
        requestId: "req-1",
        error: null,
        kanban: { orchestrator: { workspaceId: "ws-1", agentId: "agent-1" } },
      },
    });

    const reloaded = await kanbanService.get(kanban.id);
    expect(reloaded?.orchestrator).toEqual({ workspaceId: "ws-1", agentId: "agent-1" });
  });

  test("fails fast without creating a workspace when the kanban already has an orchestrator", async () => {
    const kanban = await kanbanService.getOrCreateForProject("proj-1");
    await kanbanService.provisionOrchestratorPointer(kanban.id, {
      workspaceId: "ws-existing",
      agentId: "agent-existing",
    });

    const emitted: SessionOutboundMessage[] = [];
    let archivedWorkspaceId: string | null = null;

    const session = new KanbanSession({
      host: { emit: (msg) => emitted.push(msg) },
      kanbanService,
      logger: testLogger(),
      orchestratorProvisioning: {
        projectRegistry: { get: async () => ({ rootPath: "/tmp/project-root" }) as never },
        createDirectoryWorkspace: async () => ({ workspaceId: "ws-2", cwd: "/tmp" }) as never,
        createAgent: async () => ({
          snapshot: { id: "agent-2" } as never,
          liveSnapshot: { id: "agent-2" } as never,
          background: true,
          initialPromptStarted: false,
          initialPromptError: null,
        }),
        resolveDefaultProvider: async () => "claude",
        archiveWorkspace: async (workspaceId) => {
          archivedWorkspaceId = workspaceId;
        },
      },
    });

    await session.handleOrchestratorProvisionRequest({
      type: "kanban.orchestrator.provision.request",
      requestId: "req-2",
      kanbanId: kanban.id,
    });

    expect(archivedWorkspaceId).toBeNull();
    const errorMsg = emitted.find((msg) => msg.type === "rpc_error");
    expect(errorMsg).toMatchObject({
      payload: { requestId: "req-2", error: expect.stringMatching(/already has an orchestrator/) },
    });

    const reloaded = await kanbanService.get(kanban.id);
    expect(reloaded?.orchestrator).toEqual({
      workspaceId: "ws-existing",
      agentId: "agent-existing",
    });
  });

  test("provision fails clearly when orchestrator provisioning is not configured", async () => {
    const kanban = await kanbanService.getOrCreateForProject("proj-1");
    const emitted: SessionOutboundMessage[] = [];
    const session = new KanbanSession({
      host: { emit: (msg) => emitted.push(msg) },
      kanbanService,
      logger: testLogger(),
    });

    await session.handleOrchestratorProvisionRequest({
      type: "kanban.orchestrator.provision.request",
      requestId: "req-3",
      kanbanId: kanban.id,
    });

    const errorMsg = emitted.find((msg) => msg.type === "rpc_error");
    expect(errorMsg).toMatchObject({
      payload: { requestId: "req-3", error: expect.stringMatching(/not configured/) },
    });
  });

  test("listOrchestratorPeers passthrough and unlink clear the pointer", async () => {
    const kanban = await kanbanService.getOrCreateForProject("proj-1");
    await kanbanService.provisionOrchestratorPointer(kanban.id, {
      workspaceId: "ws-1",
      agentId: "agent-1",
    });
    const emitted: SessionOutboundMessage[] = [];
    const session = new KanbanSession({
      host: { emit: (msg) => emitted.push(msg) },
      kanbanService,
      logger: testLogger(),
    });

    await session.handleOrchestratorListPeersRequest({
      type: "kanban.orchestrator.list_peers.request",
      requestId: "req-4",
    });
    const peersResponse = emitted.find(
      (msg) => msg.type === "kanban.orchestrator.list_peers.response",
    );
    expect(peersResponse).toMatchObject({
      payload: {
        requestId: "req-4",
        peers: [expect.objectContaining({ kanbanId: kanban.id, agentId: "agent-1" })],
      },
    });

    await session.handleOrchestratorUnlinkRequest({
      type: "kanban.orchestrator.unlink.request",
      requestId: "req-5",
      kanbanId: kanban.id,
    });
    const unlinkResponse = emitted.find(
      (msg) => msg.type === "kanban.orchestrator.unlink.response",
    );
    expect(unlinkResponse).toMatchObject({
      payload: { requestId: "req-5", kanban: { orchestrator: null } },
    });
  });
});
