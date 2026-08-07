import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Step, StepInput } from "@getpaseo/protocol/tasks/workflow";
import type pino from "pino";
import type { AgentManager } from "../agent/agent-manager.js";
import type { CreateAgentCommandResult } from "../agent/create-agent/create.js";
import type { CreatePaseoWorktreeWorkflowResult } from "../worktree-session.js";
import type { PersistedWorkspaceRecord } from "../workspace-registry.js";
import { createStub } from "../test-utils/class-mocks.js";
import { TaskService } from "./service.js";
import { TaskWorkflowEngine } from "./workflow-engine.js";

// Fan-out completion is event-driven (agent lifecycle subscription -> async
// store write), so tests poll for the persisted outcome instead of assuming
// a fixed number of microtask ticks settles the write.
async function waitFor(predicate: () => Promise<boolean> | boolean, timeoutMs = 2000) {
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

function stamp(steps: StepInput[]): Step[] {
  return steps.map((step, index) => ({ ...step, id: `stp_${index + 1}`, runs: [] }));
}

describe("TaskWorkflowEngine", () => {
  let tempDir: string;
  let service: TaskService;
  let agentManager: FakeAgentManager;
  let engine: TaskWorkflowEngine;
  let createdAgentCounter: number;
  let archivedWorkspaceIds: string[];
  let settledTaskIds: string[];
  let worktreeBaseBranches: Array<string | null>;
  let workspaces: Map<
    string,
    {
      workspaceId: string;
      cwd: string;
      branch?: string;
      isPaseoOwnedWorktree: boolean;
      archivedAt: string | null;
    }
  >;

  const logger = {
    child: () => logger,
    debug() {},
    info() {},
    warn() {},
    error() {},
  } as unknown as pino.Logger;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "task-workflow-engine-test-"));
    service = new TaskService({ databasePath: join(tempDir, "tasks.db"), logger });
    agentManager = new FakeAgentManager();
    createdAgentCounter = 0;
    archivedWorkspaceIds = [];
    settledTaskIds = [];
    worktreeBaseBranches = [];
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

    engine = new TaskWorkflowEngine({
      taskService: service,
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
      createWorktreeWorkspace: async (input) => {
        createdAgentCounter += 1;
        const workspaceId = `ws_wt_${createdAgentCounter}`;
        worktreeBaseBranches.push(input.baseBranch ?? null);
        const workspace = {
          workspaceId,
          cwd: `/wt/${workspaceId}`,
          branch: `paseo/${workspaceId}`,
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
    engine.setOnWorkflowSettled((taskId) => settledTaskIds.push(taskId));
  });

  afterEach(async () => {
    await service.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  async function getStep(taskId: string, stepIndex = 0): Promise<Step | undefined> {
    return (await service.getWorkflow(taskId))?.steps[stepIndex];
  }

  async function seedWorkflow(steps: StepInput[], options?: { paseoProjectId?: string }) {
    const project = await service.createProject({
      name: "Paseo",
      prefix: "PSE",
      color: "#fff",
      paseoProjectId: options?.paseoProjectId ?? "proj-1",
    });
    const task = await service.createTask({ projectId: project.id, title: "Ship it" });
    const workflow = await service.setWorkflow({ taskId: task.id, steps: stamp(steps) });
    return {
      projectId: project.id,
      taskId: task.id,
      stepIds: workflow.steps.map((step) => step.id),
    };
  }

  test("hard gate: step 2 cannot run before step 1 succeeds", async () => {
    const { taskId, stepIds } = await seedWorkflow([
      makeStepInput({ name: "Step 1" }),
      makeStepInput({ name: "Step 2" }),
    ]);

    await expect(engine.runStep({ taskId, stepId: stepIds[1] })).rejects.toThrow(/not ready/);
  });

  test("manual step runs on explicit request and succeeds when its agent finishes", async () => {
    const { taskId, stepIds } = await seedWorkflow([makeStepInput()]);

    const running = await engine.runStep({ taskId, stepId: stepIds[0] });
    expect(running.runs).toHaveLength(1);
    expect(running.runs[0].status).toBe("running");
    const agentId = running.runs[0].agentIds[0];

    agentManager.setLifecycle(agentId, "running");
    agentManager.setLifecycle(agentId, "idle");
    await waitFor(async () => (await getStep(taskId))?.runs[0]?.status === "succeeded");

    expect((await getStep(taskId))?.runs[0].status).toBe("succeeded");
  });

  /** The dispatched agent lands on the card, so the board shows who is working
   * it — but without a completion observer: the last step settling is what
   * moves the task, not each agent's turn. */
  test("dispatch attaches its agents to the task", async () => {
    const { taskId, stepIds } = await seedWorkflow([makeStepInput()]);
    const running = await engine.runStep({ taskId, stepId: stepIds[0] });

    const task = await service.getTask(taskId);
    expect(task?.agents.map((agent) => agent.agentId)).toEqual(running.runs[0].agentIds);
  });

  test("only the last step settling reports the workflow as done", async () => {
    const { taskId, stepIds } = await seedWorkflow([
      makeStepInput({ name: "Step 1", trigger: { type: "manual" } }),
      makeStepInput({ name: "Step 2", trigger: { type: "immediate" } }),
    ]);

    const running = await engine.runStep({ taskId, stepId: stepIds[0] });
    const agentId = running.runs[0].agentIds[0];
    agentManager.setLifecycle(agentId, "running");
    agentManager.setLifecycle(agentId, "idle");
    await waitFor(async () => ((await getStep(taskId, 1))?.runs.length ?? 0) === 1);

    // Step 2 dispatched automatically, and step 1 finishing settled nothing.
    expect((await getStep(taskId, 0))?.runs[0].status).toBe("succeeded");
    expect((await getStep(taskId, 1))?.runs[0].status).toBe("running");
    expect(settledTaskIds).toEqual([]);

    const secondAgentId = (await getStep(taskId, 1))!.runs[0].agentIds[0];
    agentManager.setLifecycle(secondAgentId, "running");
    agentManager.setLifecycle(secondAgentId, "idle");
    await waitFor(() => settledTaskIds.length === 1);

    expect(settledTaskIds).toEqual([taskId]);
  });

  test("fan-out: step succeeds only once every agent finishes, fails on first error", async () => {
    const { taskId, stepIds } = await seedWorkflow([
      makeStepInput({ agents: [{ provider: "claude" }, { provider: "codex" }] }),
    ]);

    const running = await engine.runStep({ taskId, stepId: stepIds[0] });
    const [agentA, agentB] = running.runs[0].agentIds;
    expect(running.runs[0].agentIds).toHaveLength(2);

    agentManager.setLifecycle(agentA, "running");
    agentManager.setLifecycle(agentA, "error");
    await waitFor(async () => (await getStep(taskId))?.runs[0]?.status === "failed");

    // The sibling keeps running and finishing does not flip the run back.
    agentManager.setLifecycle(agentB, "running");
    agentManager.setLifecycle(agentB, "idle");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await getStep(taskId))?.runs[0].status).toBe("failed");
    expect(settledTaskIds).toEqual([]);
  });

  test("retry reuses the failed run's workspace", async () => {
    const { taskId, stepIds } = await seedWorkflow([makeStepInput()]);
    const running = await engine.runStep({ taskId, stepId: stepIds[0] });
    const agentId = running.runs[0].agentIds[0];
    agentManager.setLifecycle(agentId, "running");
    agentManager.setLifecycle(agentId, "error");
    await waitFor(async () => (await getStep(taskId))?.runs[0]?.status === "failed");

    const retried = await engine.retryStep({ taskId, stepId: stepIds[0] });
    expect(retried.runs).toHaveLength(2);
    expect(retried.runs[1].workspaceIds).toEqual(["ws_shared"]);
  });

  test("skip opens the gate for the next step without running an agent", async () => {
    const { taskId, stepIds } = await seedWorkflow([
      makeStepInput({ name: "Step 1" }),
      makeStepInput({ name: "Step 2" }),
    ]);

    const skipped = await engine.skipStep({ taskId, stepId: stepIds[0] });
    expect(skipped.runs[0].status).toBe("skipped");

    await expect(engine.runStep({ taskId, stepId: stepIds[1] })).resolves.toBeDefined();
  });

  test("cancel maps to cancelAgentRunCommand and marks the run canceled", async () => {
    const { taskId, stepIds } = await seedWorkflow([makeStepInput()]);
    const running = await engine.runStep({ taskId, stepId: stepIds[0] });
    const agentId = running.runs[0].agentIds[0];
    agentManager.setLifecycle(agentId, "running");

    const canceled = await engine.cancelStep({ taskId, stepId: stepIds[0] });
    expect(canceled.runs[0].status).toBe("canceled");
    expect(agentManager.getAgent(agentId)?.lifecycle).toBe("idle");
  });

  test("restart recovery marks in-flight runs interrupted", async () => {
    const { taskId, stepIds } = await seedWorkflow([makeStepInput()]);
    await engine.runStep({ taskId, stepId: stepIds[0] });

    await engine.recoverInterruptedRuns();

    expect((await getStep(taskId))?.runs[0].status).toBe("interrupted");
  });

  test("archiveWorkspacesOnDone only archives Paseo-owned worktrees, once the workflow finishes", async () => {
    const { projectId, taskId, stepIds } = await seedWorkflow([
      makeStepInput({ workspace: { mode: "worktree" } }),
    ]);
    await service.configureBoard({ projectId, archiveWorkspacesOnDone: true });

    const running = await engine.runStep({ taskId, stepId: stepIds[0] });
    const worktreeWorkspaceId = running.runs[0].workspaceIds[0];
    expect(worktreeWorkspaceId).not.toBe("ws_shared");
    expect(archivedWorkspaceIds).not.toContain(worktreeWorkspaceId);

    const agentId = running.runs[0].agentIds[0];
    agentManager.setLifecycle(agentId, "running");
    agentManager.setLifecycle(agentId, "idle");
    await waitFor(() => archivedWorkspaceIds.includes(worktreeWorkspaceId));

    expect(archivedWorkspaceIds).toContain(worktreeWorkspaceId);
    expect(archivedWorkspaceIds).not.toContain("ws_shared");
  });

  /** A worktree needs a checkout to branch from, and a tracker project can exist
   * before any code does. The failure has to name that, not surface as a
   * missing-workspace error further down. */
  test("refuses a worktree step when the board is not linked to a Paseo project", async () => {
    const project = await service.createProject({ name: "Loose", prefix: "LSE", color: "#fff" });
    const task = await service.createTask({ projectId: project.id, title: "No checkout" });
    const workflow = await service.setWorkflow({
      taskId: task.id,
      steps: stamp([makeStepInput({ workspace: { mode: "worktree" } })]),
    });

    await expect(engine.runStep({ taskId: task.id, stepId: workflow.steps[0].id })).rejects.toThrow(
      /not linked to a Paseo project/,
    );
  });
  /** A subtask stacks on its parent instead of racing main, so its diff is
   * reviewable on its own rather than carrying everything the parent did. */
  test("a subtask's worktree starts from its parent's branch", async () => {
    const parent = await seedWorkflow([makeStepInput({ workspace: { mode: "worktree" } })]);
    const parentRun = await engine.runStep({ taskId: parent.taskId, stepId: parent.stepIds[0] });
    const parentWorkspaceId = parentRun.runs[0].workspaceIds[0];

    const child = await service.createTask({
      projectId: parent.projectId,
      title: "Subtask",
      parentTaskId: parent.taskId,
    });
    const childWorkflow = await service.setWorkflow({
      taskId: child.id,
      steps: stamp([makeStepInput({ workspace: { mode: "worktree" } })]),
    });

    await engine.runStep({ taskId: child.id, stepId: childWorkflow.steps[0].id });

    expect(worktreeBaseBranches).toEqual([null, `paseo/${parentWorkspaceId}`]);
  });

  /** A parent with no worktree has nothing to stack onto; the subtask starts
   * where any other work would. */
  test("a subtask whose parent never ran starts from the default branch", async () => {
    const parent = await seedWorkflow([makeStepInput()]);
    const child = await service.createTask({
      projectId: parent.projectId,
      title: "Subtask",
      parentTaskId: parent.taskId,
    });
    const childWorkflow = await service.setWorkflow({
      taskId: child.id,
      steps: stamp([makeStepInput({ workspace: { mode: "worktree" } })]),
    });

    await engine.runStep({ taskId: child.id, stepId: childWorkflow.steps[0].id });

    expect(worktreeBaseBranches).toEqual([null]);
  });
});
