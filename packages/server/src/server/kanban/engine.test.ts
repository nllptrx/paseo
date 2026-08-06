import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { StepInput } from "@getpaseo/protocol/kanban/rpc-schemas";
import type pino from "pino";
import type { AgentManager } from "../agent/agent-manager.js";
import type { CreateAgentCommandResult } from "../agent/create-agent/create.js";
import type { CreatePaseoWorktreeWorkflowResult } from "../worktree-session.js";
import type { PersistedWorkspaceRecord } from "../workspace-registry.js";
import { createStub } from "../test-utils/class-mocks.js";
import { KanbanStore } from "./store.js";
import { KanbanService } from "./service.js";
import { KanbanEngine } from "./engine.js";

// Fan-out completion is event-driven (agent lifecycle subscription -> async
// store write), so tests poll for the persisted outcome instead of assuming
// a fixed number of microtask ticks settles the write.
async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await predicate()) {
      return;
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor: condition was not met in time");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// ---------------------------------------------------------------------------
// Fakes — a minimal in-memory AgentManager (lifecycle pub/sub only) and a
// createAgent stub that mints predictable agent ids. Real dependencies
// (KanbanStore + KanbanService) are used per docs/testing.md; only the agent
// runtime and workspace provisioning are faked out.
// ---------------------------------------------------------------------------

type Lifecycle = "initializing" | "running" | "idle" | "error" | "closed";

class FakeAgentManager {
  private lifecycles = new Map<string, Lifecycle>();
  private subscribers: Array<{
    callback: (event: { type: "agent_state"; agent: { lifecycle: Lifecycle } }) => void;
    agentId?: string;
  }> = [];

  register(agentId: string, lifecycle: Lifecycle = "initializing"): void {
    this.lifecycles.set(agentId, lifecycle);
  }

  getAgent(agentId: string): { lifecycle: Lifecycle } | null {
    const lifecycle = this.lifecycles.get(agentId);
    return lifecycle ? { lifecycle } : null;
  }

  subscribe(
    callback: (event: { type: "agent_state"; agent: { lifecycle: Lifecycle } }) => void,
    options?: { agentId?: string },
  ): () => void {
    const entry = { callback, agentId: options?.agentId };
    this.subscribers.push(entry);
    return () => {
      this.subscribers = this.subscribers.filter((candidate) => candidate !== entry);
    };
  }

  setLifecycle(agentId: string, lifecycle: Lifecycle): void {
    this.lifecycles.set(agentId, lifecycle);
    for (const subscriber of this.subscribers) {
      if (!subscriber.agentId || subscriber.agentId === agentId) {
        subscriber.callback({ type: "agent_state", agent: { lifecycle } });
      }
    }
  }

  hasInFlightRun(): boolean {
    return true;
  }

  async cancelAgentRun(agentId: string): Promise<{ status: "settled" }> {
    this.setLifecycle(agentId, "idle");
    return { status: "settled" };
  }

  asAgentManager(): AgentManager {
    return createStub<AgentManager>({
      getAgent: this.getAgent.bind(this),
      subscribe: this.subscribe.bind(this),
      hasInFlightRun: this.hasInFlightRun.bind(this),
      cancelAgentRun: this.cancelAgentRun.bind(this),
    });
  }
}

function makeStepInput(overrides: Partial<StepInput> = {}): StepInput {
  return {
    name: "Step",
    prompt: "Do the thing",
    agents: [{ provider: "claude" }],
    completion: "all",
    workspace: { mode: "existing", workspaceId: "ws_shared" },
    trigger: { type: "manual" },
    ...overrides,
  };
}

describe("KanbanEngine", () => {
  let tempDir: string;
  let store: KanbanStore;
  let service: KanbanService;
  let agentManager: FakeAgentManager;
  let engine: KanbanEngine;
  let createdAgentCounter: number;
  let archivedWorkspaceIds: string[];
  let workspaces: Map<
    string,
    { workspaceId: string; cwd: string; isPaseoOwnedWorktree: boolean; archivedAt: string | null }
  >;

  const logger = {
    child: () => logger,
    debug() {},
    info() {},
    warn() {},
    error() {},
  } as unknown as pino.Logger;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "kanban-engine-test-"));
    store = new KanbanStore(tempDir);
    service = new KanbanService({ store, logger });
    agentManager = new FakeAgentManager();
    createdAgentCounter = 0;
    archivedWorkspaceIds = [];
    workspaces = new Map([
      [
        "ws_shared",
        {
          workspaceId: "ws_shared",
          cwd: "/ws/shared",
          isPaseoOwnedWorktree: false,
          archivedAt: null,
        },
      ],
    ]);

    engine = new KanbanEngine({
      kanbanService: service,
      agentManager: agentManager.asAgentManager(),
      createAgent: async () => {
        createdAgentCounter += 1;
        const agentId = `agt_${createdAgentCounter}`;
        agentManager.register(agentId, "initializing");
        return {
          snapshot: { id: agentId },
          liveSnapshot: { id: agentId },
          background: true,
          initialPromptStarted: true,
          initialPromptError: null,
        } as unknown as CreateAgentCommandResult;
      },
      scheduleService: { createOrReplace: vi.fn(), delete: vi.fn() },
      getWorkspace: async (workspaceId: string) =>
        (workspaces.get(workspaceId) as unknown as PersistedWorkspaceRecord) ?? null,
      getProjectRootCwd: async () => "/repo",
      createWorktreeWorkspace: async () => {
        createdAgentCounter += 1;
        const workspaceId = `ws_wt_${createdAgentCounter}`;
        const workspace = {
          workspaceId,
          cwd: `/wt/${workspaceId}`,
          isPaseoOwnedWorktree: true,
          archivedAt: null,
        };
        workspaces.set(workspaceId, workspace);
        return { workspace } as unknown as CreatePaseoWorktreeWorkflowResult;
      },
      archiveWorkspace: async (workspaceId: string) => {
        archivedWorkspaceIds.push(workspaceId);
        const workspace = workspaces.get(workspaceId);
        if (workspace) workspace.archivedAt = new Date().toISOString();
      },
      logger,
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  async function getStep(kanbanId: string, planId: string, stepIndex = 0) {
    const kanban = await service.get(kanbanId);
    const plan = kanban?.plans[planId];
    return plan?.body.type === "workflow" ? plan.body.steps[stepIndex] : undefined;
  }

  async function createWorkflowPlan(steps: StepInput[]) {
    const kanban = await service.getOrCreateForProject("proj-1");
    const plan = await service.createPlan({
      kanbanId: kanban.id,
      title: "Plan",
      body: { type: "workflow", steps },
    });
    return {
      kanbanId: kanban.id,
      planId: plan.id,
      stepIds: plan.body.type === "workflow" ? plan.body.steps.map((s) => s.id) : [],
    };
  }

  test("hard gate: step 2 cannot run before step 1 succeeds", async () => {
    const { kanbanId, planId, stepIds } = await createWorkflowPlan([
      makeStepInput({ name: "Step 1" }),
      makeStepInput({ name: "Step 2" }),
    ]);

    await expect(engine.runStep({ kanbanId, planId, stepId: stepIds[1] })).rejects.toThrow(
      /not ready/,
    );
  });

  test("manual step runs on explicit request and succeeds when its agent finishes", async () => {
    const { kanbanId, planId, stepIds } = await createWorkflowPlan([makeStepInput()]);

    const running = await engine.runStep({ kanbanId, planId, stepId: stepIds[0] });
    expect(running.runs).toHaveLength(1);
    expect(running.runs[0].status).toBe("running");
    const agentId = running.runs[0].agentIds[0];

    agentManager.setLifecycle(agentId, "running");
    agentManager.setLifecycle(agentId, "idle");
    // Completion is event-driven — wait for the async store write to land.
    await waitFor(async () => (await getStep(kanbanId, planId))?.runs[0]?.status === "succeeded");

    const step = await getStep(kanbanId, planId);
    expect(step?.runs[0].status).toBe("succeeded");
  });

  test("immediate trigger auto-advances to the next step once the previous succeeds", async () => {
    const { kanbanId, planId, stepIds } = await createWorkflowPlan([
      makeStepInput({ name: "Step 1", trigger: { type: "manual" } }),
      makeStepInput({ name: "Step 2", trigger: { type: "immediate" } }),
    ]);

    const running = await engine.runStep({ kanbanId, planId, stepId: stepIds[0] });
    const agentId = running.runs[0].agentIds[0];
    agentManager.setLifecycle(agentId, "running");
    agentManager.setLifecycle(agentId, "idle");
    await waitFor(async () => (await getStep(kanbanId, planId, 1))?.runs.length === 1);

    const step1 = await getStep(kanbanId, planId, 0);
    const step2 = await getStep(kanbanId, planId, 1);
    expect(step1?.runs[0].status).toBe("succeeded");
    // Step 2 dispatched automatically — no explicit run request for it.
    expect(step2?.runs).toHaveLength(1);
    expect(step2?.runs[0].status).toBe("running");
  });

  test("fan-out: step succeeds only once every agent finishes, fails on first error", async () => {
    const { kanbanId, planId, stepIds } = await createWorkflowPlan([
      makeStepInput({ agents: [{ provider: "claude" }, { provider: "codex" }] }),
    ]);

    const running = await engine.runStep({ kanbanId, planId, stepId: stepIds[0] });
    const [agentA, agentB] = running.runs[0].agentIds;
    expect(running.runs[0].agentIds).toHaveLength(2);

    agentManager.setLifecycle(agentA, "running");
    agentManager.setLifecycle(agentA, "error");
    await waitFor(async () => (await getStep(kanbanId, planId))?.runs[0]?.status === "failed");
    expect((await getStep(kanbanId, planId))?.runs[0].status).toBe("failed");

    // The sibling keeps running and finishing does not flip the run back.
    agentManager.setLifecycle(agentB, "running");
    agentManager.setLifecycle(agentB, "idle");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await getStep(kanbanId, planId))?.runs[0].status).toBe("failed");
  });

  test("retry reuses the failed run's workspace", async () => {
    const { kanbanId, planId, stepIds } = await createWorkflowPlan([makeStepInput()]);
    const running = await engine.runStep({ kanbanId, planId, stepId: stepIds[0] });
    const agentId = running.runs[0].agentIds[0];
    agentManager.setLifecycle(agentId, "running");
    agentManager.setLifecycle(agentId, "error");
    await waitFor(async () => (await getStep(kanbanId, planId))?.runs[0]?.status === "failed");

    const retried = await engine.retryStep({ kanbanId, planId, stepId: stepIds[0] });
    expect(retried.runs).toHaveLength(2);
    expect(retried.runs[1].workspaceIds).toEqual(["ws_shared"]);
  });

  test("skip opens the gate for the next step without running an agent", async () => {
    const { kanbanId, planId, stepIds } = await createWorkflowPlan([
      makeStepInput({ name: "Step 1" }),
      makeStepInput({ name: "Step 2" }),
    ]);

    const skipped = await engine.skipStep({ kanbanId, planId, stepId: stepIds[0] });
    expect(skipped.runs[0].status).toBe("skipped");

    // Gate now open for step 2 — no manual trigger means it stays pending
    // until an explicit request, but the gate check itself must pass.
    await expect(engine.runStep({ kanbanId, planId, stepId: stepIds[1] })).resolves.toBeDefined();
  });

  test("cancel maps to cancelAgentRunCommand and marks the run canceled", async () => {
    const { kanbanId, planId, stepIds } = await createWorkflowPlan([makeStepInput()]);
    const running = await engine.runStep({ kanbanId, planId, stepId: stepIds[0] });
    const agentId = running.runs[0].agentIds[0];
    agentManager.setLifecycle(agentId, "running");

    const canceled = await engine.cancelStep({ kanbanId, planId, stepId: stepIds[0] });
    expect(canceled.runs[0].status).toBe("canceled");
    expect(agentManager.getAgent(agentId)?.lifecycle).toBe("idle");
  });

  test("restart recovery marks in-flight runs interrupted", async () => {
    const { kanbanId, planId, stepIds } = await createWorkflowPlan([makeStepInput()]);
    await engine.runStep({ kanbanId, planId, stepId: stepIds[0] });

    await engine.recoverInterruptedRuns();

    const kanban = await service.get(kanbanId);
    const step =
      kanban!.plans[planId].body.type === "workflow"
        ? kanban!.plans[planId].body.steps[0]
        : undefined;
    expect(step?.runs[0].status).toBe("interrupted");
  });

  test("archiveWorkspacesOnDone only archives Paseo-owned worktrees, once the plan finishes", async () => {
    const kanban = await service.getOrCreateForProject("proj-4");
    await service.update(kanban.id, { archiveWorkspacesOnDone: true });
    const plan = await service.createPlan({
      kanbanId: kanban.id,
      title: "Plan",
      body: { type: "workflow", steps: [makeStepInput({ workspace: { mode: "worktree" } })] },
    });
    const stepId = plan.body.type === "workflow" ? plan.body.steps[0].id : "";

    const running = await engine.runStep({ kanbanId: kanban.id, planId: plan.id, stepId });
    const worktreeWorkspaceId = running.runs[0].workspaceIds[0];
    expect(worktreeWorkspaceId).not.toBe("ws_shared");
    // Nothing is archived while the plan is still running.
    expect(archivedWorkspaceIds).not.toContain(worktreeWorkspaceId);

    const agentId = running.runs[0].agentIds[0];
    agentManager.setLifecycle(agentId, "running");
    agentManager.setLifecycle(agentId, "idle");
    await waitFor(() => archivedWorkspaceIds.includes(worktreeWorkspaceId));

    expect(archivedWorkspaceIds).toContain(worktreeWorkspaceId);
    expect(archivedWorkspaceIds).not.toContain("ws_shared");
  });
});
