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
  mcpBaseUrl: string | null = "http://127.0.0.1:6767/mcp/agents";
  private subscribers: Array<{
    callback: (event: { type: "agent_state"; agent: { lifecycle: Lifecycle } }) => void;
    agentId?: string;
  }> = [];

  register(agentId: string, lifecycle: Lifecycle = "initializing"): void {
    this.lifecycles.set(agentId, lifecycle);
  }

  getAgent(
    agentId: string,
  ): { lifecycle: Lifecycle; pendingPermissions: Map<string, unknown> } | null {
    const lifecycle = this.lifecycles.get(agentId);
    return lifecycle ? { lifecycle, pendingPermissions: new Map() } : null;
  }

  subscribe(
    callback: (event: {
      type: "agent_state";
      agent: { lifecycle: Lifecycle; pendingPermissions: Map<string, unknown> };
    }) => void,
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
        subscriber.callback({
          type: "agent_state",
          agent: { lifecycle, pendingPermissions: new Map() },
        });
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
      getMcpBaseUrl: () => this.mcpBaseUrl,
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

function requireTaskGit(
  deps: ConstructorParameters<typeof TaskWorkflowEngine>[0],
): NonNullable<ConstructorParameters<typeof TaskWorkflowEngine>[0]["taskGit"]> {
  const taskGit = deps.taskGit;
  if (!taskGit) throw new Error("test task Git adapter is missing");
  return taskGit;
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
  let directoryWorkspaceCwds: string[];
  let taskBranches: Set<string>;
  let taskBranchBases: Array<{ branch: string; baseBranch: string }>;
  let integratedWorkspaces: Array<{ cwd: string; targetBranch: string }>;
  let integratedBranches: Array<{ sourceBranch: string; targetBranch: string }>;
  let createdAgentPrompts: string[];
  let createdAgentFeatures: Array<Record<string, unknown> | undefined>;
  let engineDeps: () => ConstructorParameters<typeof TaskWorkflowEngine>[0];
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
    directoryWorkspaceCwds = [];
    taskBranches = new Set(["main"]);
    taskBranchBases = [];
    integratedWorkspaces = [];
    integratedBranches = [];
    createdAgentPrompts = [];
    createdAgentFeatures = [];
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

    engineDeps = () => ({
      taskService: service,
      agentManager: agentManager.asAgentManager(),
      createAgent: async (input) => {
        createdAgentPrompts.push(input.initialPrompt ?? "");
        createdAgentFeatures.push(input.features);
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
        worktreeBaseBranches.push(input.refName ?? null);
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
      createDirectoryWorkspace: async (input) => {
        const workspaceId = `ws_dir_${input.cwd.replaceAll("/", "_")}`;
        const workspace = {
          workspaceId,
          cwd: input.cwd,
          branch: null,
          isPaseoOwnedWorktree: false,
          archivedAt: null,
        };
        workspaces.set(workspaceId, workspace);
        directoryWorkspaceCwds.push(input.cwd);
        return workspace as unknown as PersistedWorkspaceRecord;
      },
      archiveWorkspace: async (workspaceId: string) => {
        archivedWorkspaceIds.push(workspaceId);
        const workspace = workspaces.get(workspaceId);
        if (workspace) workspace.archivedAt = new Date().toISOString();
      },
      taskGit: {
        isRepository: async () => true,
        hasCommits: async () => true,
        resolveDefaultBranch: async () => "main",
        branchExists: async (_cwd, branch) => taskBranches.has(branch),
        createBranch: async (_cwd, branch, baseBranch) => {
          taskBranches.add(branch);
          taskBranchBases.push({ branch, baseBranch });
        },
        integrateWorkspace: async (cwd, targetBranch) => {
          integratedWorkspaces.push({ cwd, targetBranch });
        },
        integrateBranch: async (_cwd, sourceBranch, targetBranch) => {
          integratedBranches.push({ sourceBranch, targetBranch });
        },
      },
      logger,
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    });
    engine = new TaskWorkflowEngine(engineDeps());
    engine.setOnWorkflowSettled((taskId) => settledTaskIds.push(taskId));
  });

  afterEach(async () => {
    await service.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  async function getStep(taskId: string, stepIndex = 0): Promise<Step | undefined> {
    return (await service.getWorkflow(taskId))?.steps[stepIndex];
  }

  let seededProjects = 0;
  async function seedWorkflow(steps: StepInput[], options?: { paseoProjectId?: string }) {
    seededProjects += 1;
    const project = await service.createProject({
      name: "Paseo",
      prefix: `PSE${seededProjects}`,
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
    expect(createdAgentPrompts.at(-1)).toContain(taskId);
    expect(createdAgentPrompts.at(-1)).toContain("Do the thing");
    expect(createdAgentPrompts.at(-1)).toContain("Paseo task environment");
    expect(createdAgentPrompts.at(-1)).toContain("Workflow position: step 1 of 1");

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

  test("editing a paused plan to auto-continue starts its ready next step", async () => {
    const { taskId, stepIds } = await seedWorkflow([
      makeStepInput({ name: "Step 1", trigger: { type: "manual" } }),
      makeStepInput({ name: "Step 2", trigger: { type: "manual" } }),
    ]);
    const first = await engine.runStep({ taskId, stepId: stepIds[0] });
    const firstAgentId = first.runs[0].agentIds[0];
    agentManager.setLifecycle(firstAgentId, "running");
    agentManager.setLifecycle(firstAgentId, "idle");
    await waitFor(async () => (await getStep(taskId, 0))?.runs[0]?.status === "succeeded");

    const workflow = await service.getWorkflow(taskId);
    const firstStep = workflow!.steps[0]!;
    const secondStep = workflow!.steps[1]!;
    await service.setWorkflow({
      taskId,
      steps: [firstStep, { ...secondStep, trigger: { type: "immediate" } }],
    });
    await engine.continueReadyWorkflow(taskId);

    expect((await getStep(taskId, 1))?.runs[0]?.status).toBe("running");
  });

  test("attaches and settles a scheduled step from schedule lifecycle events", async () => {
    const createOrReplace = vi.fn(async () => ({ id: "sched_1" }) as never);
    const scheduledEngine = new TaskWorkflowEngine({
      ...engineDeps(),
      scheduleService: {
        createOrReplace,
        delete: vi.fn(),
      },
    });
    scheduledEngine.setOnWorkflowSettled((taskId) => settledTaskIds.push(taskId));
    const seeded = await seedWorkflow([
      makeStepInput({ name: "Implement" }),
      makeStepInput({
        name: "Later verify",
        trigger: { type: "schedule", cadence: { type: "every", everyMs: 60_000 } },
      }),
    ]);
    const first = await scheduledEngine.runStep({
      taskId: seeded.taskId,
      stepId: seeded.stepIds[0],
    });
    const firstAgentId = first.runs[0].agentIds[0];
    agentManager.setLifecycle(firstAgentId, "running");
    agentManager.setLifecycle(firstAgentId, "idle");
    await waitFor(async () => (await getStep(seeded.taskId, 1))?.runs[0]?.scheduleId === "sched_1");
    expect(createOrReplace.mock.calls[0]?.[0].prompt).toContain("Paseo task environment");
    expect(createOrReplace.mock.calls[0]?.[0].prompt).toContain(
      "Workflow position: step 2 of 2 — Later verify",
    );

    await scheduledEngine.handleScheduleRunLifecycle({
      type: "before_run",
      scheduleId: "sched_1",
      scheduleRunId: "schedule-run-1",
    });
    await scheduledEngine.handleScheduleRunLifecycle({
      type: "agent_started",
      scheduleId: "sched_1",
      scheduleRunId: "schedule-run-1",
      agentId: "scheduled-agent",
      workspaceId: "ws_shared",
    });
    expect((await service.getTask(seeded.taskId))?.status).toBe("in_progress");
    expect((await service.getTask(seeded.taskId))?.agents).toEqual([
      expect.objectContaining({ agentId: firstAgentId, completionOwner: "workflow" }),
      expect.objectContaining({
        agentId: "scheduled-agent",
        completionOwner: "workflow",
      }),
    ]);

    await scheduledEngine.handleScheduleRunLifecycle({
      type: "settled",
      scheduleId: "sched_1",
      scheduleRunId: "schedule-run-1",
      status: "succeeded",
      agentId: "scheduled-agent",
      error: null,
      endedAt: "2026-01-01T00:01:00.000Z",
    });

    expect((await getStep(seeded.taskId, 1))?.runs[0]).toMatchObject({
      status: "succeeded",
      agentIds: ["scheduled-agent"],
      endedAt: "2026-01-01T00:01:00.000Z",
    });
    expect(settledTaskIds).toEqual([seeded.taskId]);
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

  /** The agent that did the work holds the context a fresh chat would have to
   * re-derive, so a retry continues that conversation with the failure. */
  test("retry resumes the failed run's agent instead of opening a new chat", async () => {
    const resumes: Array<{ agentId: string; prompt: string }> = [];
    engine = new TaskWorkflowEngine({
      ...engineDeps(),
      resumeAgent: async (input) => {
        resumes.push(input);
      },
    });
    const { taskId, stepIds } = await seedWorkflow([makeStepInput()]);
    const running = await engine.runStep({ taskId, stepId: stepIds[0] });
    const agentId = running.runs[0].agentIds[0];
    agentManager.setLifecycle(agentId, "running");
    agentManager.setLifecycle(agentId, "error");
    await waitFor(async () => (await getStep(taskId))?.runs[0]?.status === "failed");

    const createdBefore = createdAgentPrompts.length;
    const retried = await engine.retryStep({ taskId, stepId: stepIds[0] });
    expect(retried.runs[1].agentIds).toEqual([agentId]);
    expect(createdAgentPrompts).toHaveLength(createdBefore);
    expect(resumes).toHaveLength(1);
    expect(resumes[0].agentId).toBe(agentId);
    expect(resumes[0].prompt).toContain("retried");
    expect(resumes[0].prompt).toContain("Paseo task environment");
    expect(resumes[0].prompt).toContain("Workflow position: step 1 of 1");
  });

  /** An agent that can no longer take a prompt must not strand the retry. */
  test("retry falls back to a fresh agent when the resume fails", async () => {
    engine = new TaskWorkflowEngine({
      ...engineDeps(),
      resumeAgent: async () => {
        throw new Error("agent is gone");
      },
    });
    const { taskId, stepIds } = await seedWorkflow([makeStepInput()]);
    const running = await engine.runStep({ taskId, stepId: stepIds[0] });
    const agentId = running.runs[0].agentIds[0];
    agentManager.setLifecycle(agentId, "running");
    agentManager.setLifecycle(agentId, "error");
    await waitFor(async () => (await getStep(taskId))?.runs[0]?.status === "failed");

    const retried = await engine.retryStep({ taskId, stepId: stepIds[0] });
    expect(retried.runs[1].agentIds).toHaveLength(1);
    expect(retried.runs[1].agentIds[0]).not.toBe(agentId);
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

  test("archiveWorkspacesOnDone waits for final task completion and only archives Paseo-owned worktrees", async () => {
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
    await waitFor(() => settledTaskIds.includes(taskId));

    expect(archivedWorkspaceIds).not.toContain(worktreeWorkspaceId);

    await engine.archiveTaskWorkspacesAfterDone(taskId);

    expect(archivedWorkspaceIds).toContain(worktreeWorkspaceId);
    expect(archivedWorkspaceIds).not.toContain("ws_shared");
  });

  test("a task can enable workspace cleanup when its board keeps workspaces", async () => {
    const { taskId, stepIds } = await seedWorkflow([
      makeStepInput({ workspace: { mode: "worktree" } }),
    ]);
    await service.updateTask({
      taskId,
      executionPolicy: { archiveWorkspacesOnDone: true },
    });
    const running = await engine.runStep({ taskId, stepId: stepIds[0] });
    const workspaceId = running.runs[0].workspaceIds[0];
    await service.updateTask({ taskId, status: "done" });

    await engine.archiveTaskWorkspacesAfterDone(taskId);

    expect(archivedWorkspaceIds).toContain(workspaceId);
  });

  /** Work needs a folder to happen in, and a tracker project can exist before
   * any code does. The failure has to name that, not surface as a
   * missing-workspace error further down. */
  test("refuses a worktree step when the board is not linked to a Paseo project", async () => {
    const project = await service.createProject({ name: "Loose", prefix: "LSE", color: "#fff" });
    const task = await service.createTask({ projectId: project.id, title: "No checkout" });
    const workflow = await service.setWorkflow({
      taskId: task.id,
      steps: stamp([makeStepInput({ workspace: { mode: "worktree" } })]),
    });

    await expect(engine.runStep({ taskId: task.id, stepId: workflow.steps[0].id })).rejects.toThrow(
      /has no folder to work in/,
    );
  });

  /** A folder Git cannot back still hosts work: the agent runs in the project
   * folder, and no task branch is invented for it. */
  test("runs a worktree step in the project folder when Git cannot back it", async () => {
    const { taskId, stepIds } = await seedWorkflow([
      makeStepInput({ workspace: { mode: "worktree" } }),
    ]);
    engine = new TaskWorkflowEngine({
      ...engineDeps(),
      taskGit: { ...requireTaskGit(engineDeps()), isRepository: async () => false },
    });

    const running = await engine.runStep({ taskId, stepId: stepIds[0] });

    expect(directoryWorkspaceCwds).toEqual(["/repo"]);
    expect(workspaces.get(running.runs[0].workspaceIds[0])?.cwd).toBe("/repo");
    expect([...taskBranches].filter((branch) => branch.startsWith("paseo/tasks/"))).toEqual([]);
    expect((await service.getTask(taskId))?.integration ?? null).toBeNull();
  });

  test("refuses to fan out into worktrees when Git cannot back the folder", async () => {
    const { taskId, stepIds } = await seedWorkflow([
      makeStepInput({
        workspace: { mode: "worktree_per_agent" },
        agents: [{ provider: "claude" }, { provider: "claude" }],
      }),
    ]);
    engine = new TaskWorkflowEngine({
      ...engineDeps(),
      taskGit: { ...requireTaskGit(engineDeps()), hasCommits: async () => false },
    });

    await expect(engine.runStep({ taskId, stepId: stepIds[0] })).rejects.toThrow(
      /needs a Git repository with at least one commit/,
    );
  });

  test("completes tracker-only work without requiring a Git project", async () => {
    const project = await service.createProject({ name: "Loose", prefix: "LSE", color: "#fff" });
    const task = await service.createTask({ projectId: project.id, title: "Human task" });

    await expect(engine.integrateTaskIntoParent(task.id)).resolves.toBeUndefined();
    expect((await service.getTask(task.id))?.integration).toBeUndefined();
  });
  /** Every task has a durable branch. A child starts from its parent's durable
   * branch, while each worker starts from the branch of the task it owns. */
  test("a subtask's worktree starts from its own branch stacked on its parent", async () => {
    const parent = await seedWorkflow([makeStepInput({ workspace: { mode: "worktree" } })]);
    const parentRun = await engine.runStep({ taskId: parent.taskId, stepId: parent.stepIds[0] });
    void parentRun;

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

    const project = await service.getProject(parent.projectId);
    const parentBranch = `paseo/tasks/${project?.prefix.toLowerCase()}-1`;
    const childBranch = `paseo/tasks/${project?.prefix.toLowerCase()}-2`;
    expect(taskBranchBases).toEqual([
      { branch: parentBranch, baseBranch: "main" },
      { branch: childBranch, baseBranch: parentBranch },
    ]);
    expect(worktreeBaseBranches).toEqual([parentBranch, childBranch]);
  });

  test("a subtask whose parent never ran still stacks through both task branches", async () => {
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

    const project = await service.getProject(parent.projectId);
    const parentBranch = `paseo/tasks/${project?.prefix.toLowerCase()}-1`;
    const childBranch = `paseo/tasks/${project?.prefix.toLowerCase()}-2`;
    expect(taskBranchBases).toEqual([
      { branch: parentBranch, baseBranch: "main" },
      { branch: childBranch, baseBranch: parentBranch },
    ]);
    expect(worktreeBaseBranches).toEqual([childBranch]);
  });

  test("integrates worker work into the task branch before delivering a child to its parent", async () => {
    const parent = await seedWorkflow([makeStepInput()]);
    const child = await service.createTask({
      projectId: parent.projectId,
      title: "Subtask",
      parentTaskId: parent.taskId,
    });
    await service.attachAgent({ taskId: child.id, agentId: "agt_child", workspaceId: "ws_shared" });

    await engine.integrateTaskIntoParent(child.id);

    const project = await service.getProject(parent.projectId);
    const parentBranch = `paseo/tasks/${project?.prefix.toLowerCase()}-1`;
    const childBranch = `paseo/tasks/${project?.prefix.toLowerCase()}-2`;
    expect(integratedWorkspaces).toEqual([{ cwd: "/ws/shared", targetBranch: childBranch }]);
    expect(integratedBranches).toEqual([{ sourceBranch: childBranch, targetBranch: parentBranch }]);
    expect((await service.getTask(child.id))?.integration).toEqual({
      branch: childBranch,
      status: "integrated",
      error: null,
    });
  });

  test("persists a child merge conflict without marking it integrated", async () => {
    const parent = await seedWorkflow([makeStepInput()]);
    const child = await service.createTask({
      projectId: parent.projectId,
      title: "Subtask",
      parentTaskId: parent.taskId,
    });
    await service.attachAgent({ taskId: child.id, agentId: "agt_child", workspaceId: "ws_shared" });
    const deps = engineDeps();
    const taskGit = deps.taskGit;
    if (!taskGit) throw new Error("test task Git adapter is missing");
    engine = new TaskWorkflowEngine({
      ...deps,
      taskGit: {
        ...taskGit,
        integrateBranch: async () => {
          throw new Error("merge conflict in src/task.ts");
        },
      },
    });

    await expect(engine.integrateTaskIntoParent(child.id)).rejects.toThrow(/merge conflict/);

    expect((await service.getTask(child.id))?.integration).toMatchObject({
      status: "conflicted",
      error: "merge conflict in src/task.ts",
    });
  });

  test("serializes sibling delivery into their shared parent branch", async () => {
    const parent = await seedWorkflow([makeStepInput()]);
    const first = await service.createTask({
      projectId: parent.projectId,
      title: "First child",
      parentTaskId: parent.taskId,
    });
    const second = await service.createTask({
      projectId: parent.projectId,
      title: "Second child",
      parentTaskId: parent.taskId,
      parallel: true,
    });
    await service.attachAgent({ taskId: first.id, agentId: "agt_first", workspaceId: "ws_shared" });
    await service.attachAgent({
      taskId: second.id,
      agentId: "agt_second",
      workspaceId: "ws_shared",
    });
    const deps = engineDeps();
    const taskGit = deps.taskGit;
    if (!taskGit) throw new Error("test task Git adapter is missing");
    let concurrent = 0;
    let maximumConcurrent = 0;
    engine = new TaskWorkflowEngine({
      ...deps,
      taskGit: {
        ...taskGit,
        integrateBranch: async () => {
          concurrent += 1;
          maximumConcurrent = Math.max(maximumConcurrent, concurrent);
          await new Promise((resolve) => setTimeout(resolve, 10));
          concurrent -= 1;
        },
      },
    });

    await Promise.all([
      engine.integrateTaskIntoParent(first.id),
      engine.integrateTaskIntoParent(second.id),
    ]);

    expect(maximumConcurrent).toBe(1);
  });
  /** The short path a workflow makes long: a preset is a one-step workflow you
   * do not have to author, and the agent lands attached. */
  test("delegating a preset attaches the agent it starts", async () => {
    const { projectId, taskId } = await seedWorkflow([makeStepInput()]);
    const preset = await service.createPreset({
      name: "Implement",
      provider: "claude",
      environmentKind: "new_worktree",
      instructions: "Follow the house style.",
      featureValues: { fast_mode: true },
    });

    const { agentId } = await engine.delegate({ taskId, presetId: preset.id });

    const task = await service.getTask(taskId);
    expect(task?.agents.map((agent) => agent.agentId)).toEqual([agentId]);
    expect(task?.agents[0].presetId).toBe(preset.id);
    expect(createdAgentPrompts.at(-1)).toContain(`PSE${seededProjects}-1`);
    expect(createdAgentPrompts.at(-1)).toContain(taskId);
    expect(createdAgentPrompts.at(-1)).toContain("Paseo task environment");
    expect(createdAgentPrompts.at(-1)).toContain("Role: worker attached to this card");
    expect(createdAgentFeatures.at(-1)).toEqual({ fast_mode: true });
    void projectId;
  });

  test("a task can require a dedicated worktree for ordinary delegation", async () => {
    const { taskId } = await seedWorkflow([makeStepInput()]);
    await service.updateTask({
      taskId,
      executionPolicy: { workspace: "dedicated" },
    });
    const preset = await service.createPreset({
      name: "Implement in place",
      provider: "claude",
      environmentKind: "project_default",
    });

    await engine.delegate({ taskId, presetId: preset.id });
    const delegated = await service.getTask(taskId);

    expect(delegated?.agents[0]?.workspaceId).toMatch(/^ws_wt_/);
    expect(worktreeBaseBranches[0]).toMatch(/^paseo\/tasks\/pse\d+-1$/);
  });

  test("a task can reuse attached work despite a dedicated-worktree preset", async () => {
    const { taskId } = await seedWorkflow([makeStepInput()]);
    await service.attachAgent({ taskId, agentId: "agt_existing", workspaceId: "ws_shared" });
    await service.updateTask({
      taskId,
      executionPolicy: { workspace: "reuse" },
    });
    const preset = await service.createPreset({
      name: "Implement separately",
      provider: "claude",
      environmentKind: "new_worktree",
    });

    const { agentId } = await engine.delegate({ taskId, presetId: preset.id });
    const delegated = await service.getTask(taskId);

    expect(delegated?.agents.find((link) => link.agentId === agentId)?.workspaceId).toBe(
      "ws_shared",
    );
    expect(worktreeBaseBranches).toEqual([]);
  });

  /** The gate belongs to claiming, so it has to stop a delegate before an agent
   * exists — not leave one running against work that should not start. */
  test("refuses to delegate a task whose blockers are open", async () => {
    const { projectId, taskId } = await seedWorkflow([makeStepInput()]);
    const blocker = await service.createTask({ projectId, title: "First" });
    await service.addDependency({ taskId, dependsOnTaskId: blocker.id });
    const preset = await service.createPreset({
      name: "Implement",
      provider: "claude",
      environmentKind: "new_worktree",
    });

    const beforeCreateCount = createdAgentCounter;
    await expect(engine.delegate({ taskId, presetId: preset.id })).rejects.toThrow(/blocked by/);
    expect(createdAgentCounter).toBe(beforeCreateCount);
    expect(createdAgentPrompts).toEqual([]);
  });

  test("refuses to run a blocked workflow before creating workspaces or agents", async () => {
    const { projectId, taskId, stepIds } = await seedWorkflow([
      makeStepInput({ workspace: { mode: "worktree" } }),
    ]);
    const blocker = await service.createTask({ projectId, title: "First" });
    await service.addDependency({ taskId, dependsOnTaskId: blocker.id });
    const beforeCreateCount = createdAgentCounter;

    await expect(engine.runStep({ taskId, stepId: stepIds[0] })).rejects.toThrow(/blocked by/);

    expect(createdAgentCounter).toBe(beforeCreateCount);
    expect(createdAgentPrompts).toEqual([]);
    expect((await service.getTask(taskId))?.agents).toEqual([]);
  });

  test("stops a workflow agent when a blocker arrives during dispatch", async () => {
    const { projectId, taskId, stepIds } = await seedWorkflow([makeStepInput()]);
    const blocker = await service.createTask({ projectId, title: "First" });
    const deps = engineDeps();
    const createAgent = deps.createAgent;
    deps.createAgent = async (input) => {
      const created = await createAgent(input);
      await service.addDependency({ taskId, dependsOnTaskId: blocker.id });
      return created;
    };
    const racingEngine = new TaskWorkflowEngine(deps);

    await expect(racingEngine.runStep({ taskId, stepId: stepIds[0] })).rejects.toThrow(
      /blocked by/,
    );

    expect((await service.getTask(taskId))?.agents).toEqual([]);
    expect(agentManager.getAgent("agt_1")?.lifecycle).toBe("idle");
    expect((await service.getWorkflow(taskId))?.steps[0].runs[0].status).toBe("failed");
  });

  test("cleans up a delegated agent and worktree when claiming loses a race", async () => {
    const { projectId, taskId } = await seedWorkflow([makeStepInput()]);
    const blocker = await service.createTask({ projectId, title: "First" });
    const preset = await service.createPreset({
      name: "Implement",
      provider: "claude",
      environmentKind: "new_worktree",
    });
    const deps = engineDeps();
    const createAgent = deps.createAgent;
    deps.createAgent = async (input) => {
      const created = await createAgent(input);
      await service.addDependency({ taskId, dependsOnTaskId: blocker.id });
      return created;
    };
    const racingEngine = new TaskWorkflowEngine(deps);

    await expect(racingEngine.delegate({ taskId, presetId: preset.id })).rejects.toThrow(
      /blocked by/,
    );

    expect((await service.getTask(taskId))?.agents).toEqual([]);
    expect(agentManager.getAgent("agt_2")?.lifecycle).toBe("idle");
    expect(archivedWorkspaceIds).toEqual(["ws_wt_1"]);
  });
  async function secondRunStatus(taskId: string): Promise<boolean> {
    const step = (await service.getWorkflow(taskId))?.steps[0];
    return step?.runs.at(-1)?.status === "running";
  }

  /** The cap bounds how much work starts, and the queue is a row rather than
   * an in-memory list so a restart does not lose a card's turn. */
  test("queues a run past the cap and starts it when a slot frees", async () => {
    const capped = new TaskWorkflowEngine({ ...engineDeps(), maxConcurrentRuns: 1 });
    const first = await seedWorkflow([makeStepInput()]);
    const second = await seedWorkflow([makeStepInput()]);

    const running = await capped.runStep({ taskId: first.taskId, stepId: first.stepIds[0] });
    expect(running.runs[0].status).toBe("running");

    const queued = await capped.runStep({ taskId: second.taskId, stepId: second.stepIds[0] });
    expect(queued.runs[0].status).toBe("queued");
    expect(queued.runs[0].agentIds).toEqual([]);

    const agentId = running.runs[0].agentIds[0];
    agentManager.setLifecycle(agentId, "running");
    agentManager.setLifecycle(agentId, "idle");

    await waitFor(() => secondRunStatus(second.taskId));

    const secondStep = (await service.getWorkflow(second.taskId))?.steps[0];
    // The placeholder is replaced, not stacked: the step was attempted once.
    expect(secondStep?.runs).toHaveLength(1);
    expect(secondStep?.runs[0].agentIds).toHaveLength(1);
  });

  /** The tracker that marks a slot taken is only registered after the
   * workspaces are resolved and the agents created. Two dispatches racing
   * through that window both used to read the same free slot. */
  test("holds the cap against dispatches that start together", async () => {
    const capped = new TaskWorkflowEngine({ ...engineDeps(), maxConcurrentRuns: 1 });
    const first = await seedWorkflow([makeStepInput()]);
    const second = await seedWorkflow([makeStepInput()]);

    const [one, two] = await Promise.all([
      capped.runStep({ taskId: first.taskId, stepId: first.stepIds[0] }),
      capped.runStep({ taskId: second.taskId, stepId: second.stepIds[0] }),
    ]);

    const statuses = [one.runs[0].status, two.runs[0].status].sort();
    expect(statuses).toEqual(["queued", "running"]);
  });

  /** A queue only a live process knows about is a queue a crash erases. */
  test("starts a run left queued by a crash at boot", async () => {
    const capped = new TaskWorkflowEngine({ ...engineDeps(), maxConcurrentRuns: 1 });
    const first = await seedWorkflow([makeStepInput()]);
    const second = await seedWorkflow([makeStepInput()]);
    await capped.runStep({ taskId: first.taskId, stepId: first.stepIds[0] });
    await capped.runStep({ taskId: second.taskId, stepId: second.stepIds[0] });

    // A fresh engine is what a restart looks like: no trackers, rows intact.
    const rebooted = new TaskWorkflowEngine({ ...engineDeps(), maxConcurrentRuns: 1 });
    await rebooted.recoverInterruptedRuns();

    const firstStep = (await service.getWorkflow(first.taskId))?.steps[0];
    expect(firstStep?.runs[0].status).toBe("interrupted");
    const secondStep = (await service.getWorkflow(second.taskId))?.steps[0];
    expect(secondStep?.runs.at(-1)?.status).toBe("running");
  });

  test("refuses a second request while a run is queued", async () => {
    const capped = new TaskWorkflowEngine({ ...engineDeps(), maxConcurrentRuns: 1 });
    const first = await seedWorkflow([makeStepInput()]);
    const second = await seedWorkflow([makeStepInput()]);
    await capped.runStep({ taskId: first.taskId, stepId: first.stepIds[0] });
    await capped.runStep({ taskId: second.taskId, stepId: second.stepIds[0] });

    await expect(
      capped.runStep({ taskId: second.taskId, stepId: second.stepIds[0] }),
    ).rejects.toThrow(/already has a run in progress/);
  });
  /** One checkout with several writers is a race the engine would be handing
   * out. worktree_per_agent exists for this, so it says so. */
  test("refuses to fan out several agents into one shared worktree", async () => {
    const { taskId, stepIds } = await seedWorkflow([
      makeStepInput({
        workspace: { mode: "worktree" },
        agents: [{ provider: "claude" }, { provider: "codex" }],
      }),
    ]);

    await expect(engine.runStep({ taskId, stepId: stepIds[0] })).rejects.toThrow(
      /worktree_per_agent/,
    );
  });

  /** Every agent stopping is the earliest a step could be done, not proof that
   * it is: a step that asks for evidence and has none did not succeed. */
  test("fails a settled step whose workspace it cannot inspect for evidence", async () => {
    const { taskId } = await seedWorkflow([makeStepInput()]);
    const workflow = await service.setWorkflow({
      taskId,
      steps: stamp([makeStepInput({ requireChanges: true })]),
    });
    const stepId = workflow.steps[0].id;

    const running = await engine.runStep({ taskId, stepId });
    workspaces.delete(running.runs[0].workspaceIds[0]);
    const agentId = running.runs[0].agentIds[0];
    agentManager.setLifecycle(agentId, "running");
    agentManager.setLifecycle(agentId, "idle");

    await waitFor(async () => {
      const step = (await service.getWorkflow(taskId))?.steps[0];
      return step?.runs[0]?.status === "failed";
    });

    const step = (await service.getWorkflow(taskId))?.steps[0];
    expect(step?.runs[0].error).toMatch(/no workspace to check/);
    expect(settledTaskIds).toEqual([]);
  });

  /** An agent that loops is not an agent that errors: nothing else would ever
   * stop it, and the card would wait on it forever. */
  test("stops a run that outlives its step's timeout", async () => {
    const { taskId } = await seedWorkflow([makeStepInput()]);
    const workflow = await service.setWorkflow({
      taskId,
      steps: stamp([makeStepInput({ timeoutMs: 30 })]),
    });
    const stepId = workflow.steps[0].id;

    const running = await engine.runStep({ taskId, stepId });
    agentManager.setLifecycle(running.runs[0].agentIds[0], "running");

    await waitFor(async () => {
      const step = (await service.getWorkflow(taskId))?.steps[0];
      return step?.runs[0]?.status === "failed";
    });

    const step = (await service.getWorkflow(taskId))?.steps[0];
    expect(step?.runs[0].error).toMatch(/longer than its 30ms limit/);
  });

  /** A review is a second judgement or it is nothing: the reviewer is a new
   * agent, and it is on the card as a reviewer so the tracker can tell it from
   * the hands that did the work. */
  test("puts a fresh reviewer on a card, attached as a reviewer", async () => {
    const { projectId, taskId } = await seedWorkflow([makeStepInput()]);
    const preset = await service.createPreset({
      name: "Reviewer",
      provider: "claude",
      environmentKind: "project_default",
      instructions: "Be strict.",
    });
    await service.configureBoard({ projectId, reviewerPresetId: preset.id });
    await service.attachAgent({ taskId, agentId: "agt_worker", workspaceId: "ws_shared" });

    const requested = await engine.requestReview(taskId);

    expect(requested).not.toBeNull();
    const task = await service.getTask(taskId);
    const reviewer = task?.agents.find((agent) => agent.agentId === requested?.agentId);
    expect(reviewer?.role).toBe("reviewer");
    expect(reviewer?.workspaceId).not.toBe("ws_shared");
    expect(worktreeBaseBranches.at(-1)).toMatch(/^paseo\/tasks\/pse\d+-1$/);
    expect(await service.listTaskWorkerIds(taskId)).toEqual(["agt_worker"]);
    expect(createdAgentPrompts.at(-1)).toContain(`PSE${seededProjects}-1`);
    expect(createdAgentPrompts.at(-1)).toContain(taskId);
    expect(createdAgentPrompts.at(-1)).toContain("Paseo task environment");
    expect(createdAgentPrompts.at(-1)).toContain("Role: independent reviewer");
  });

  test("a task can choose a different reviewer than its board", async () => {
    const { projectId, taskId } = await seedWorkflow([makeStepInput()]);
    const boardReviewer = await service.createPreset({
      name: "Board reviewer",
      provider: "claude",
      environmentKind: "project_default",
      instructions: "BOARD REVIEWER",
    });
    const taskReviewer = await service.createPreset({
      name: "Task reviewer",
      provider: "claude",
      environmentKind: "project_default",
      instructions: "TASK REVIEWER",
    });
    await service.configureBoard({ projectId, reviewerPresetId: boardReviewer.id });
    await service.updateTask({
      taskId,
      executionPolicy: { reviewerPresetId: taskReviewer.id },
    });
    await service.attachAgent({ taskId, agentId: "agt_worker", workspaceId: "ws_shared" });

    await engine.requestReview(taskId);

    expect(createdAgentPrompts.at(-1)).toContain("TASK REVIEWER");
    expect(createdAgentPrompts.at(-1)).not.toContain("BOARD REVIEWER");
  });

  test("does not review a board that names no reviewer", async () => {
    const { taskId } = await seedWorkflow([makeStepInput()]);
    await service.attachAgent({ taskId, agentId: "agt_worker", workspaceId: "ws_shared" });

    expect(await engine.requestReview(taskId)).toBeNull();
  });

  /** A reviewer records its verdict through the daemon's MCP tools. Starting one
   * without them spends a whole run on a judgement the tracker can never hear. */
  test("refuses to start a reviewer when the daemon injects no MCP tools", async () => {
    const { projectId, taskId } = await seedWorkflow([makeStepInput()]);
    const preset = await service.createPreset({
      name: "Reviewer",
      provider: "claude",
      environmentKind: "project_default",
    });
    await service.configureBoard({ projectId, reviewerPresetId: preset.id });
    agentManager.mcpBaseUrl = null;

    await expect(engine.requestReview(taskId)).rejects.toThrow(/mcp\.injectIntoAgents/);
    expect((await service.getTask(taskId))?.agents).toEqual([]);
    expect(createdAgentPrompts).toEqual([]);
  });

  test("refuses to review with a preset the board no longer has", async () => {
    const { projectId, taskId } = await seedWorkflow([makeStepInput()]);
    const preset = await service.createPreset({
      name: "Reviewer",
      provider: "claude",
      environmentKind: "project_default",
    });
    await service.configureBoard({ projectId, reviewerPresetId: preset.id });
    await service.deletePreset(preset.id);

    await expect(engine.requestReview(taskId)).rejects.toThrow(/no longer exists/);
  });

  /** The review judged the integrated branch, so a rejection belongs to every
   * worker that fed it — not only the newest one. */
  test("sends rejected review feedback to every attached worker", async () => {
    const resumed: Array<{ agentId: string; prompt: string }> = [];
    engine = new TaskWorkflowEngine({
      ...engineDeps(),
      resumeAgent: async (input) => {
        resumed.push(input);
      },
    });
    const { taskId } = await seedWorkflow([makeStepInput()]);
    await service.attachAgent({ taskId, agentId: "agt_1", workspaceId: "ws_one" });
    await service.attachAgent({ taskId, agentId: "agt_2", workspaceId: "ws_two" });
    await service.attachAgent({
      taskId,
      agentId: "agt_reviewer",
      workspaceId: "ws_review",
      role: "reviewer",
    });

    const correction = await engine.requestCorrection({ taskId, feedback: "Fix the race" });

    expect(correction).toEqual({ agentIds: ["agt_1", "agt_2"] });
    expect(resumed.map((entry) => entry.agentId)).toEqual(["agt_1", "agt_2"]);
    expect(resumed[0].prompt).toContain("Fix the race");
    expect(resumed[0].prompt).toContain(taskId);
    expect(resumed[0].prompt).toContain("Paseo task environment");
    expect(resumed[0].prompt).toContain("Role: worker correcting a rejected review");
  });

  test("corrects the workers it can when one cannot be resumed", async () => {
    const resumed: string[] = [];
    engine = new TaskWorkflowEngine({
      ...engineDeps(),
      resumeAgent: async (input) => {
        if (input.agentId === "agt_1") {
          throw new Error("agent unavailable");
        }
        resumed.push(input.agentId);
      },
    });
    const { taskId } = await seedWorkflow([makeStepInput()]);
    await service.attachAgent({ taskId, agentId: "agt_1", workspaceId: "ws_one" });
    await service.attachAgent({ taskId, agentId: "agt_2", workspaceId: "ws_two" });

    expect(await engine.requestCorrection({ taskId, feedback: "Fix it" })).toEqual({
      agentIds: ["agt_2"],
    });
    expect(resumed).toEqual(["agt_2"]);
  });

  test("briefs the worker resumed to repair an integration conflict", async () => {
    const resumed: Array<{ agentId: string; prompt: string }> = [];
    engine = new TaskWorkflowEngine({
      ...engineDeps(),
      resumeAgent: async (input) => {
        resumed.push(input);
      },
    });
    const { taskId } = await seedWorkflow([makeStepInput()]);
    await service.updateTask({
      taskId,
      integration: {
        branch: "paseo/tasks/pse-1",
        status: "conflicted",
        error: "content conflict",
      },
    });
    await service.attachAgent({ taskId, agentId: "agt_worker", workspaceId: "ws_shared" });

    await engine.requestIntegrationFix({ taskId, error: "content conflict" });

    expect(resumed).toHaveLength(1);
    expect(resumed[0].prompt).toContain("Paseo task environment");
    expect(resumed[0].prompt).toContain("Role: worker resolving a failed task-branch integration");
    expect(resumed[0].prompt).toContain("Git reported: content conflict");
  });

  /** The review checkout exists for one judgement on the task branch. Left
   * behind it is a dead worktree that also outranks the workers' checkouts when
   * the card next looks for a workspace. */
  test("archives a stopped reviewer's worktree", async () => {
    const { projectId, taskId } = await seedWorkflow([makeStepInput()]);
    const preset = await service.createPreset({
      name: "Reviewer",
      provider: "claude",
      environmentKind: "project_default",
    });
    await service.configureBoard({ projectId, reviewerPresetId: preset.id });
    const requested = await engine.requestReview(taskId);
    const reviewerWorkspaceId = (await service.getTask(taskId))?.agents.find(
      (agent) => agent.agentId === requested?.agentId,
    )?.workspaceId;

    await engine.releaseReviewer({
      taskId,
      agentId: requested?.agentId ?? "",
      cancelAgent: false,
    });

    expect(archivedWorkspaceIds).toEqual([reviewerWorkspaceId]);
  });

  test("leaves a worker's workspace alone when releasing a reviewer that shares it", async () => {
    const { taskId } = await seedWorkflow([makeStepInput()]);
    await service.attachAgent({ taskId, agentId: "agt_worker", workspaceId: "ws_shared" });
    await service.attachAgent({
      taskId,
      agentId: "agt_reviewer",
      workspaceId: "ws_shared",
      role: "reviewer",
    });

    await engine.releaseReviewer({ taskId, agentId: "agt_reviewer", cancelAgent: false });

    expect(archivedWorkspaceIds).toEqual([]);
  });

  /** A leaf executes and an aggregate aggregates: a worker on a task with
   * subtasks would deliver into a branch its own children are merging into. */
  test("refuses to delegate a task that has subtasks", async () => {
    const { projectId, taskId } = await seedWorkflow([makeStepInput()]);
    await service.createTask({ projectId, title: "Phase one", parentTaskId: taskId });
    const preset = await service.createPreset({
      name: "Implement",
      provider: "claude",
      environmentKind: "new_worktree",
    });
    const beforeCreateCount = createdAgentCounter;

    await expect(engine.delegate({ taskId, presetId: preset.id })).rejects.toThrow(
      /workers attach to its subtasks instead/,
    );
    expect(createdAgentCounter).toBe(beforeCreateCount);
  });

  test("refuses to run a workflow step on a task that has subtasks", async () => {
    const { projectId, taskId, stepIds } = await seedWorkflow([makeStepInput()]);
    await service.createTask({ projectId, title: "Phase one", parentTaskId: taskId });

    await expect(engine.runStep({ taskId, stepId: stepIds[0] })).rejects.toThrow(
      /workers attach to its subtasks instead/,
    );
  });

  /** The subtasks were each judged on their own branch. What nobody has looked
   * at is the integrated result. */
  test("the final review of an aggregate carries the child verdicts and asks about the integration", async () => {
    const { projectId, taskId } = await seedWorkflow([makeStepInput()]);
    const child = await service.createTask({ projectId, title: "Phase one", parentTaskId: taskId });
    await service.emitBoardEvent({
      kind: "task_approved",
      taskId: child.id,
      verdict: "approve",
      cause: "passed review and integrated into its parent",
    });
    const preset = await service.createPreset({
      name: "Reviewer",
      provider: "claude",
      environmentKind: "project_default",
    });
    await service.configureBoard({ projectId, reviewerPresetId: preset.id });

    await engine.requestReview(taskId);

    const prompt = createdAgentPrompts.at(-1) ?? "";
    expect(prompt).toContain("integrated result");
    expect(prompt).toContain(`PSE${seededProjects}-2 "Phase one" passed review`);
    expect(prompt).toContain("Do not review each subtask's diff again");
    expect(prompt).toContain("Paseo task environment");
    expect(prompt).toContain("Role: independent reviewer");
  });

  test("a rejected final review resumes the aggregate's most recent surviving worker", async () => {
    const resumed: Array<{ agentId: string; prompt: string }> = [];
    engine = new TaskWorkflowEngine({
      ...engineDeps(),
      resumeAgent: async (input) => {
        resumed.push(input);
      },
    });
    const { projectId, taskId } = await seedWorkflow([makeStepInput()]);
    await service.createTask({ projectId, title: "Phase one", parentTaskId: taskId });
    await service.attachAgent({
      taskId,
      agentId: "agt_old",
      workspaceId: "ws_gone",
      allowAggregate: true,
    });
    await service.attachAgent({
      taskId,
      agentId: "agt_recent",
      workspaceId: "ws_shared",
      allowAggregate: true,
    });

    const correction = await engine.requestCorrection({
      taskId,
      feedback: "The two phases disagree about the config shape",
    });

    expect(correction).toEqual({ agentIds: ["agt_recent"] });
    expect(resumed).toHaveLength(1);
    expect(resumed[0].prompt).toContain("The two phases disagree about the config shape");
    expect(resumed[0].prompt).toContain("the subtasks that are Done stay done");
    expect(resumed[0].prompt).toContain("Paseo task environment");
  });

  test("starts a fresh corrector on the task branch when no aggregate worker survives", async () => {
    engine = new TaskWorkflowEngine({
      ...engineDeps(),
      resumeAgent: async () => {
        throw new Error("agent unavailable");
      },
    });
    const { projectId, taskId } = await seedWorkflow([makeStepInput()]);
    await service.createTask({ projectId, title: "Phase one", parentTaskId: taskId });
    const preset = await service.createPreset({
      name: "Implement",
      provider: "claude",
      environmentKind: "new_worktree",
    });
    await service.updateTask({
      taskId,
      executionSpec: { presetId: preset.id, trigger: "manual" },
    });

    const correction = await engine.requestCorrection({ taskId, feedback: "Wire the phases up" });

    expect(correction?.agentIds).toHaveLength(1);
    const corrector = (await service.getTask(taskId))?.agents.at(-1);
    expect(corrector?.agentId).toBe(correction?.agentIds[0]);
    expect(worktreeBaseBranches.at(-1)).toMatch(/^paseo\/tasks\/pse\d+-1$/);
    expect(createdAgentPrompts.at(-1)).toContain("Wire the phases up");
    expect(createdAgentPrompts.at(-1)).toContain("Paseo task environment");
  });

  /** The next phase is still working in the checkout its predecessor used, so
   * the chain's worktree outlives each subtask's Done. */
  test("keeps a worktree a subtask chain shares until the aggregate settles", async () => {
    const { projectId, taskId } = await seedWorkflow([makeStepInput()]);
    await service.configureBoard({ projectId, archiveWorkspacesOnDone: true });
    const first = await service.createTask({ projectId, title: "Phase one", parentTaskId: taskId });
    const second = await service.createTask({
      projectId,
      title: "Phase two",
      parentTaskId: taskId,
    });
    await service.attachAgent({ taskId: first.id, agentId: "agt_first", workspaceId: "ws_wt_1" });
    workspaces.set("ws_wt_1", {
      workspaceId: "ws_wt_1",
      cwd: "/wt/ws_wt_1",
      isPaseoOwnedWorktree: true,
      archivedAt: null,
    });
    await service.updateTask({ taskId: first.id, status: "done" });
    await service.attachAgent({ taskId: second.id, agentId: "agt_second", workspaceId: "ws_wt_1" });

    await engine.archiveTaskWorkspacesAfterDone(first.id);
    expect(archivedWorkspaceIds).toEqual([]);

    await engine.archiveTaskWorkspacesAfterDone(taskId);
    expect(archivedWorkspaceIds).toEqual(["ws_wt_1"]);
  });

  test("releases a subtask's own worktree at its own Done", async () => {
    const { projectId, taskId } = await seedWorkflow([makeStepInput()]);
    await service.configureBoard({ projectId, archiveWorkspacesOnDone: true });
    const child = await service.createTask({ projectId, title: "Phase one", parentTaskId: taskId });
    workspaces.set("ws_wt_child", {
      workspaceId: "ws_wt_child",
      cwd: "/wt/ws_wt_child",
      isPaseoOwnedWorktree: true,
      archivedAt: null,
    });
    await service.attachAgent({
      taskId: child.id,
      agentId: "agt_child",
      workspaceId: "ws_wt_child",
    });

    await engine.archiveTaskWorkspacesAfterDone(child.id);

    expect(archivedWorkspaceIds).toEqual(["ws_wt_child"]);
  });

  test("restores workflow completion ownership when resuming a correction fails", async () => {
    engine = new TaskWorkflowEngine({
      ...engineDeps(),
      resumeAgent: async () => {
        throw new Error("agent unavailable");
      },
    });
    const { taskId } = await seedWorkflow([makeStepInput()]);
    await service.attachAgent({
      taskId,
      agentId: "agt_1",
      workspaceId: "ws_shared",
      completionOwner: "workflow",
    });

    await expect(engine.requestCorrection({ taskId, feedback: "Fix it" })).rejects.toThrow(
      /agent unavailable/,
    );

    expect((await service.getTask(taskId))?.agents[0]?.completionOwner).toBe("workflow");
  });
});
