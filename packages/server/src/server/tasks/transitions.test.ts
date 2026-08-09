import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskBoardConfig } from "@getpaseo/protocol/tasks/types";
import type { ManagedAgent } from "../agent/agent-manager.js";
import { TaskService } from "./service.js";
import { TaskTransitionEngine } from "./transitions.js";

const logger = pino({ level: "silent" });

interface FakeAgentEvent {
  type: "agent_state";
  agent: Pick<ManagedAgent, "lifecycle">;
}

/** Just enough of AgentManager for the engine: per-agent listeners it can feed. */
function createFakeAgentManager() {
  const listeners = new Map<string, Set<(event: FakeAgentEvent) => void>>();
  return {
    subscribe(listener: (event: FakeAgentEvent) => void, options: { agentId: string }) {
      const bucket = listeners.get(options.agentId) ?? new Set();
      bucket.add(listener);
      listeners.set(options.agentId, bucket);
      return () => {
        bucket.delete(listener);
      };
    },
    snapshots: new Map<string, ManagedAgent["lifecycle"]>(),
    getAgent(agentId: string) {
      const lifecycle = this.snapshots.get(agentId);
      return lifecycle ? ({ lifecycle } as ManagedAgent) : null;
    },
    emitLifecycle(agentId: string, lifecycle: ManagedAgent["lifecycle"]) {
      this.snapshots.set(agentId, lifecycle);
      for (const listener of listeners.get(agentId) ?? []) {
        listener({ type: "agent_state", agent: { lifecycle } });
      }
    },
    listenerCount(agentId: string): number {
      return listeners.get(agentId)?.size ?? 0;
    },
  };
}

describe("TaskTransitionEngine", () => {
  let directory: string;
  let service: TaskService;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "paseo-task-transitions-"));
    service = new TaskService({ databasePath: join(directory, "tasks.db"), logger });
  });

  afterEach(async () => {
    await service.close();
    rmSync(directory, { recursive: true, force: true });
  });

  async function seedTask(input?: {
    review?: TaskBoardConfig;
    reviewTimeoutMs?: number;
    maxReviewAttempts?: number;
  }) {
    const project = await service.createProject({
      name: "Paseo",
      prefix: "PSE",
      color: "#fff",
      paseoProjectId: "proj-1",
    });
    const task = await service.createTask({
      projectId: project.id,
      title: "Ship it",
      status: "in_progress",
    });
    if (input?.review) {
      await service.configureBoard({ projectId: project.id, ...input.review });
    }
    const agentManager = createFakeAgentManager();
    const engine = new TaskTransitionEngine({
      taskService: service,
      agentManager,
      logger,
      ...(input?.reviewTimeoutMs !== undefined ? { reviewTimeoutMs: input.reviewTimeoutMs } : {}),
      ...(input?.maxReviewAttempts !== undefined
        ? { maxReviewAttempts: input.maxReviewAttempts }
        : {}),
    });
    engine.setIntegrateTaskWork(async () => undefined);
    engine.setIntegrateTaskIntoParent(async () => undefined);
    return { task, engine, agentManager, projectId: project.id };
  }

  async function feedText(projectId: string): Promise<string> {
    const feed = await service.listBoardFeed({ projectId });
    return feed.map((entry) => entry.body).join("\n");
  }

  it("moves a task to done when work settles and the board does not review", async () => {
    const { task, engine, projectId } = await seedTask();
    await engine.onWorkSettled(task.id);
    expect((await service.getTask(task.id))?.status).toBe("done");

    const feed = await service.listBoardFeed({ projectId });
    expect(feed.map((entry) => ({ kind: entry.kind, body: entry.body }))).toEqual([
      {
        kind: "system",
        body: `PSE-1 "Ship it" settled its attached work and moved to done.`,
      },
    ]);
    expect(feed[0].taskId).toBe(task.id);
  });

  it("moves a task to in_review when the board reviews", async () => {
    const { task, engine } = await seedTask({
      review: {
        reviewEnabled: true,
        reviewOnReject: "in_progress",
        archiveWorkspacesOnDone: false,
      },
    });
    await engine.onWorkSettled(task.id);
    expect((await service.getTask(task.id))?.status).toBe("in_review");
  });

  it("returns integration failures to Working and asks the worker to fix them", async () => {
    const { task, engine, projectId } = await seedTask();
    const fixes: Array<{ taskId: string; error: string }> = [];
    engine.setIntegrateTaskWork(async () => {
      throw new Error("conflict in src/task.ts");
    });
    engine.setRequestIntegrationFix(async (input) => {
      fixes.push(input);
    });

    await engine.onWorkSettled(task.id);

    expect((await service.getTask(task.id))?.status).toBe("in_progress");
    await vi.waitFor(() =>
      expect(fixes).toEqual([{ taskId: task.id, error: "conflict in src/task.ts" }]),
    );
    const feed = await service.listBoardFeed({ projectId });
    expect(feed.at(-1)?.body).toContain("could not integrate and moved back to in_progress");
  });

  it("does not finish or unblock a subtask when parent integration conflicts", async () => {
    const { task, engine, projectId } = await seedTask({
      review: {
        reviewEnabled: true,
        reviewOnReject: "in_progress",
        archiveWorkspacesOnDone: false,
      },
    });
    const parent = await service.createTask({ projectId, title: "Parent" });
    await service.updateTask({ taskId: task.id, parentTaskId: parent.id, status: "in_review" });
    const dependent = await service.createTask({ projectId, title: "After child" });
    await service.addDependency({ taskId: dependent.id, dependsOnTaskId: task.id });
    engine.setIntegrateTaskIntoParent(async () => {
      throw new Error("content conflict");
    });

    const result = await engine.applyReviewVerdict({ taskId: task.id, verdict: "approve" });

    expect(result.status).toBe("in_progress");
    expect((await service.listBlockers(dependent.id)).map((entry) => entry.id)).toEqual([task.id]);
  });

  it("keeps a parent active until every non-canceled subtask is done", async () => {
    const { task, engine, projectId } = await seedTask();
    const child = await service.createTask({
      projectId,
      parentTaskId: task.id,
      title: "Still working",
      status: "in_progress",
    });

    const blocked = await engine.completeTask(task.id);
    expect(blocked.status).toBe("in_progress");

    await service.updateTask({ taskId: child.id, status: "canceled" });
    const completed = await engine.completeTask(task.id);
    expect(completed.status).toBe("done");
  });

  it("lets one task override the board review default", async () => {
    const { task, engine } = await seedTask();
    await service.updateTask({
      taskId: task.id,
      executionPolicy: { review: "required" },
    });

    await engine.onWorkSettled(task.id);

    expect((await service.getTask(task.id))?.status).toBe("in_review");
  });

  it("lets one task skip review on a reviewing board", async () => {
    const { task, engine } = await seedTask({
      review: {
        reviewEnabled: true,
        reviewOnReject: "in_progress",
        archiveWorkspacesOnDone: false,
      },
    });
    await service.updateTask({
      taskId: task.id,
      executionPolicy: { review: "disabled" },
    });

    await engine.onWorkSettled(task.id);

    expect((await service.getTask(task.id))?.status).toBe("done");
  });

  it("leaves done and canceled tasks alone", async () => {
    const { task, engine } = await seedTask();
    await service.updateTask({ taskId: task.id, status: "canceled" });
    await engine.onWorkSettled(task.id);
    expect((await service.getTask(task.id))?.status).toBe("canceled");
  });

  it("ignores stale work completion after a task has left in progress", async () => {
    const { task, engine } = await seedTask();
    await service.updateTask({ taskId: task.id, status: "todo" });
    await engine.onWorkSettled(task.id, "agent-1");
    expect((await service.getTask(task.id))?.status).toBe("todo");
  });

  it("approves a review to done and rejects it back to the configured status", async () => {
    const { task, engine } = await seedTask({
      review: { reviewEnabled: true, reviewOnReject: "todo", archiveWorkspacesOnDone: false },
    });
    await service.updateTask({ taskId: task.id, status: "in_review" });

    const rejected = await engine.applyReviewVerdict({ taskId: task.id, verdict: "reject" });
    expect(rejected.status).toBe("todo");

    await service.updateTask({ taskId: task.id, status: "in_review" });
    const approved = await engine.applyReviewVerdict({ taskId: task.id, verdict: "approve" });
    expect(approved.status).toBe("done");
  });

  it("runs final cleanup only after approval when review is enabled", async () => {
    const { task, engine } = await seedTask({
      review: {
        reviewEnabled: true,
        reviewOnReject: "in_progress",
        archiveWorkspacesOnDone: true,
      },
    });
    const cleaned: string[] = [];
    engine.setOnTaskDone(async (taskId) => {
      cleaned.push(taskId);
    });

    await engine.onWorkSettled(task.id);
    expect(cleaned).toEqual([]);

    await engine.applyReviewVerdict({ taskId: task.id, verdict: "approve" });
    expect(cleaned).toEqual([task.id]);
  });

  it("runs bounded correction rounds and then requires human review", async () => {
    const { task, engine } = await seedTask({
      review: {
        reviewEnabled: true,
        reviewOnReject: "in_progress",
        maxReviewIterations: 2,
        archiveWorkspacesOnDone: false,
      },
    });
    const corrections: Array<{ taskId: string; feedback: string | null }> = [];
    engine.setRequestCorrection(async (input) => {
      corrections.push(input);
      return { agentIds: ["agent-1"] };
    });

    await engine.onWorkSettled(task.id);
    const first = await engine.applyReviewVerdict({
      taskId: task.id,
      verdict: "reject",
      feedback: "Fix the race",
    });
    expect(first).toMatchObject({ status: "in_progress", reviewIteration: 1 });

    await engine.onWorkSettled(task.id);
    const second = await engine.applyReviewVerdict({ taskId: task.id, verdict: "reject" });
    expect(second).toMatchObject({ status: "in_progress", reviewIteration: 2 });

    await engine.onWorkSettled(task.id);
    const exhausted = await engine.applyReviewVerdict({ taskId: task.id, verdict: "reject" });
    expect(exhausted).toMatchObject({ status: "in_review", reviewIteration: 2 });
    expect(corrections).toEqual([
      { taskId: task.id, feedback: "Fix the race" },
      { taskId: task.id, feedback: null },
    ]);
  });

  it("watches every worker a correction resumed", async () => {
    const { task, engine, agentManager } = await seedTask({
      review: {
        reviewEnabled: true,
        reviewOnReject: "in_progress",
        archiveWorkspacesOnDone: false,
      },
    });
    await service.attachAgent({ taskId: task.id, agentId: "worker-1", workspaceId: "ws-1" });
    await service.attachAgent({ taskId: task.id, agentId: "worker-2", workspaceId: "ws-2" });
    await service.updateTask({ taskId: task.id, status: "in_review" });
    engine.setRequestCorrection(async () => ({ agentIds: ["worker-1", "worker-2"] }));

    await engine.applyReviewVerdict({ taskId: task.id, verdict: "reject", feedback: "Both" });

    expect(agentManager.listenerCount("worker-1")).toBe(1);
    expect(agentManager.listenerCount("worker-2")).toBe(1);
  });

  it("uses a task's correction-round limit instead of the board default", async () => {
    const { task, engine } = await seedTask({
      review: {
        reviewEnabled: true,
        reviewOnReject: "in_progress",
        archiveWorkspacesOnDone: false,
        maxReviewIterations: 5,
      },
    });
    await service.updateTask({
      taskId: task.id,
      status: "in_review",
      executionPolicy: { maxReviewIterations: 1 },
    });
    engine.setRequestCorrection(async () => ({ agentIds: ["worker"] }));

    await engine.applyReviewVerdict({ taskId: task.id, verdict: "reject", feedback: "Again" });
    await service.updateTask({ taskId: task.id, status: "in_review" });
    await engine.applyReviewVerdict({
      taskId: task.id,
      verdict: "reject",
      feedback: "Still wrong",
    });

    const reviewed = await service.getTask(task.id);
    expect(reviewed?.status).toBe("in_review");
    expect(reviewed?.reviewIteration).toBe(1);
  });

  it("returns to review when correction work cannot be started", async () => {
    const { task, engine, projectId } = await seedTask({
      review: {
        reviewEnabled: true,
        reviewOnReject: "in_progress",
        maxReviewIterations: 3,
        archiveWorkspacesOnDone: false,
      },
    });
    await service.updateTask({ taskId: task.id, status: "in_review" });
    engine.setRequestCorrection(async () => {
      throw new Error("worker is gone");
    });

    const result = await engine.applyReviewVerdict({ taskId: task.id, verdict: "reject" });

    expect(result).toMatchObject({ status: "in_review", reviewIteration: 0 });
    const feed = await service.listBoardFeed({ projectId });
    expect(feed.map((entry) => entry.body).join("\n")).toContain("could not start correction work");
  });

  it("allows only one review verdict to be in flight for a task", async () => {
    const { task, engine } = await seedTask({
      review: {
        reviewEnabled: true,
        reviewOnReject: "in_progress",
        archiveWorkspacesOnDone: false,
      },
    });
    await service.updateTask({ taskId: task.id, status: "in_review" });
    let releaseCleanup: (() => void) | null = null;
    engine.setOnTaskDone(
      () =>
        new Promise<void>((resolve) => {
          releaseCleanup = resolve;
        }),
    );

    const approval = engine.applyReviewVerdict({ taskId: task.id, verdict: "approve" });
    await vi.waitFor(() => expect(releaseCleanup).not.toBeNull());
    await expect(engine.applyReviewVerdict({ taskId: task.id, verdict: "reject" })).rejects.toThrow(
      /already being decided/,
    );
    releaseCleanup?.();
    await approval;
  });

  it("refuses a verdict on a task that is not in review", async () => {
    const { task, engine } = await seedTask();
    await expect(
      engine.applyReviewVerdict({ taskId: task.id, verdict: "approve" }),
    ).rejects.toThrow(/not in review/);
  });

  it("moves the task when an observed attached agent finishes, and not when it errors", async () => {
    const { task, engine, agentManager } = await seedTask();
    await service.attachAgent({ taskId: task.id, agentId: "agent-1", workspaceId: "ws-1" });
    engine.observeAttachment({ taskId: task.id, agentId: "agent-1" });

    agentManager.emitLifecycle("agent-1", "error");
    await new Promise((resolve) => setImmediate(resolve));
    expect((await service.getTask(task.id))?.status).toBe("in_progress");

    agentManager.emitLifecycle("agent-1", "running");
    agentManager.emitLifecycle("agent-1", "idle");
    await new Promise((resolve) => setImmediate(resolve));
    expect((await service.getTask(task.id))?.status).toBe("done");
  });

  it("keeps observing across turns: a second finish moves a task pushed back to work", async () => {
    const { task, engine, agentManager } = await seedTask();
    engine.observeAttachment({ taskId: task.id, agentId: "agent-1" });

    agentManager.emitLifecycle("agent-1", "running");
    agentManager.emitLifecycle("agent-1", "idle");
    await new Promise((resolve) => setImmediate(resolve));
    expect((await service.getTask(task.id))?.status).toBe("done");

    await service.updateTask({ taskId: task.id, status: "in_progress" });
    agentManager.emitLifecycle("agent-1", "running");
    agentManager.emitLifecycle("agent-1", "idle");
    await new Promise((resolve) => setImmediate(resolve));
    expect((await service.getTask(task.id))?.status).toBe("done");
  });

  it("waits for every attached worker before advancing a task", async () => {
    const { task, engine, agentManager } = await seedTask();
    await service.attachAgent({ taskId: task.id, agentId: "agent-1", workspaceId: "ws-1" });
    await service.attachAgent({ taskId: task.id, agentId: "agent-2", workspaceId: "ws-2" });
    engine.observeAttachment({ taskId: task.id, agentId: "agent-1" });
    engine.observeAttachment({ taskId: task.id, agentId: "agent-2" });

    agentManager.emitLifecycle("agent-1", "running");
    agentManager.emitLifecycle("agent-2", "running");
    agentManager.emitLifecycle("agent-1", "idle");
    await new Promise((resolve) => setImmediate(resolve));
    expect((await service.getTask(task.id))?.status).toBe("in_progress");

    agentManager.emitLifecycle("agent-2", "idle");
    await new Promise((resolve) => setImmediate(resolve));
    expect((await service.getTask(task.id))?.status).toBe("done");
  });

  it("starts a fresh reviewer when the first one finishes without a verdict", async () => {
    const { task, engine, agentManager, projectId } = await seedTask({
      review: {
        reviewEnabled: true,
        reviewOnReject: "in_progress",
        archiveWorkspacesOnDone: false,
      },
      maxReviewAttempts: 2,
    });
    const requested: string[] = [];
    engine.setRequestReview(async () => {
      const agentId = `reviewer-${requested.length + 1}`;
      requested.push(agentId);
      return { agentId };
    });

    await engine.onWorkSettled(task.id);
    await vi.waitFor(() => expect(requested).toEqual(["reviewer-1"]));
    agentManager.emitLifecycle("reviewer-1", "running");
    agentManager.emitLifecycle("reviewer-1", "idle");

    await vi.waitFor(() => expect(requested).toEqual(["reviewer-1", "reviewer-2"]));
    expect((await service.getTask(task.id))?.status).toBe("in_review");
    expect(await feedText(projectId)).toContain(
      "finished without recording a verdict; the board is starting a fresh review",
    );
  });

  it("stops retrying reviewers and leaves the card to a human", async () => {
    const { task, engine, agentManager, projectId } = await seedTask({
      review: {
        reviewEnabled: true,
        reviewOnReject: "in_progress",
        archiveWorkspacesOnDone: false,
      },
      maxReviewAttempts: 2,
    });
    const requested: string[] = [];
    engine.setRequestReview(async () => {
      const agentId = `reviewer-${requested.length + 1}`;
      requested.push(agentId);
      return { agentId };
    });

    await engine.onWorkSettled(task.id);
    await vi.waitFor(() => expect(requested).toHaveLength(1));
    agentManager.emitLifecycle("reviewer-1", "running");
    agentManager.emitLifecycle("reviewer-1", "error");
    await vi.waitFor(() => expect(requested).toHaveLength(2));
    agentManager.emitLifecycle("reviewer-2", "running");
    agentManager.emitLifecycle("reviewer-2", "error");

    await vi.waitFor(async () =>
      expect(await feedText(projectId)).toContain("this task still requires review"),
    );
    expect(requested).toEqual(["reviewer-1", "reviewer-2"]);
    expect((await service.getTask(task.id))?.status).toBe("in_review");
  });

  /** A reviewer that loops is not an error anyone observes: without a ceiling
   * the card waits on it forever. */
  it("stops a reviewer that runs past its limit and releases its checkout", async () => {
    const { task, engine, agentManager, projectId } = await seedTask({
      review: {
        reviewEnabled: true,
        reviewOnReject: "in_progress",
        archiveWorkspacesOnDone: false,
      },
      reviewTimeoutMs: 10,
      maxReviewAttempts: 1,
    });
    const released: Array<{ agentId: string; cancelAgent: boolean }> = [];
    engine.setRequestReview(async () => ({ agentId: "reviewer-1" }));
    engine.setReleaseReviewer(async (input) => {
      released.push({ agentId: input.agentId, cancelAgent: input.cancelAgent });
    });

    await engine.onWorkSettled(task.id);
    agentManager.emitLifecycle("reviewer-1", "running");

    await vi.waitFor(async () =>
      expect(await feedText(projectId)).toContain("ran past the 10ms review limit"),
    );
    expect(released).toEqual([{ agentId: "reviewer-1", cancelAgent: true }]);
    expect((await service.getTask(task.id))?.status).toBe("in_review");
  });

  it("releases the review checkout once a verdict has landed", async () => {
    const { task, engine, agentManager } = await seedTask({
      review: {
        reviewEnabled: true,
        reviewOnReject: "in_progress",
        archiveWorkspacesOnDone: false,
      },
    });
    const released: Array<{ agentId: string; cancelAgent: boolean }> = [];
    engine.setRequestReview(async () => ({ agentId: "reviewer-1" }));
    engine.setReleaseReviewer(async (input) => {
      released.push({ agentId: input.agentId, cancelAgent: input.cancelAgent });
    });

    await engine.onWorkSettled(task.id);
    agentManager.emitLifecycle("reviewer-1", "running");
    await engine.applyReviewVerdict({ taskId: task.id, verdict: "approve" });
    agentManager.emitLifecycle("reviewer-1", "idle");

    await vi.waitFor(() =>
      expect(released).toEqual([{ agentId: "reviewer-1", cancelAgent: false }]),
    );
    expect((await service.getTask(task.id))?.status).toBe("done");
  });

  /** A board that names a reviewer and quietly falls back to a human reads
   * exactly like a board with no reviewer at all. */
  it("says on the card when a review cannot be started", async () => {
    const { task, engine, projectId } = await seedTask({
      review: {
        reviewEnabled: true,
        reviewOnReject: "in_progress",
        archiveWorkspacesOnDone: false,
      },
    });
    engine.setRequestReview(async () => {
      throw new Error("The reviewer preset pre-1 no longer exists");
    });

    await engine.onWorkSettled(task.id);

    await vi.waitFor(async () =>
      expect(await feedText(projectId)).toContain(
        "could not start its review and now requires a human: The reviewer preset pre-1 no longer exists",
      ),
    );
    expect((await service.getTask(task.id))?.status).toBe("in_review");
  });

  it("stops observing when the agent closes or is detached", async () => {
    const { task, engine, agentManager } = await seedTask();
    engine.observeAttachment({ taskId: task.id, agentId: "agent-1" });
    expect(agentManager.listenerCount("agent-1")).toBe(1);

    agentManager.emitLifecycle("agent-1", "closed");
    expect(agentManager.listenerCount("agent-1")).toBe(0);

    engine.observeAttachment({ taskId: task.id, agentId: "agent-2" });
    engine.unobserveAttachment({ taskId: task.id, agentId: "agent-2" });
    expect(agentManager.listenerCount("agent-2")).toBe(0);
  });

  it("re-arms observers for stored attachments on start", async () => {
    const { task, engine, agentManager } = await seedTask();
    await service.attachAgent({ taskId: task.id, agentId: "agent-1", workspaceId: "ws-1" });
    await engine.start();

    agentManager.emitLifecycle("agent-1", "running");
    agentManager.emitLifecycle("agent-1", "idle");
    await new Promise((resolve) => setImmediate(resolve));
    expect((await service.getTask(task.id))?.status).toBe("done");
  });

  it("does not re-arm workflow-owned step agents as task completion", async () => {
    const { task, engine, agentManager } = await seedTask();
    await service.attachAgent({
      taskId: task.id,
      agentId: "workflow-step-1",
      workspaceId: "ws-1",
      completionOwner: "workflow",
    });
    await engine.start();

    expect(agentManager.listenerCount("workflow-step-1")).toBe(0);
    agentManager.emitLifecycle("workflow-step-1", "running");
    agentManager.emitLifecycle("workflow-step-1", "idle");
    await new Promise((resolve) => setImmediate(resolve));
    expect((await service.getTask(task.id))?.status).toBe("in_progress");
  });

  it("re-arms stored reviewers with review semantics", async () => {
    const { task, engine, agentManager, projectId } = await seedTask({
      review: {
        reviewEnabled: true,
        reviewOnReject: "in_progress",
        archiveWorkspacesOnDone: false,
      },
    });
    await service.updateTask({ taskId: task.id, status: "in_review" });
    await service.attachAgent({
      taskId: task.id,
      agentId: "reviewer-1",
      workspaceId: "ws-1",
      role: "reviewer",
    });
    await engine.start();

    agentManager.emitLifecycle("reviewer-1", "running");
    agentManager.emitLifecycle("reviewer-1", "idle");
    await vi.waitFor(async () => {
      const feed = await service.listBoardFeed({ projectId });
      let bodies = "";
      for (const entry of feed) bodies += `${entry.body}\n`;
      expect(bodies).toContain("without recording a verdict");
    });
    expect((await service.getTask(task.id))?.status).toBe("in_review");
  });
  /** A failure moves nothing, so without a word in the feed it is invisible
   * until someone opens the card. */
  it("records a stalled agent in the feed without moving the task", async () => {
    const { task, engine, agentManager, projectId } = await seedTask();
    engine.observeAttachment({ taskId: task.id, agentId: "agt_1" });

    agentManager.emitLifecycle("agt_1", "running");
    agentManager.emitLifecycle("agt_1", "error");
    await vi.waitFor(async () => {
      expect((await service.listBoardFeed({ projectId })).length).toBeGreaterThan(0);
    });

    const feed = await service.listBoardFeed({ projectId });
    expect(feed[0].kind).toBe("system");
    expect(feed[0].body).toContain("stopped on an error");
    expect(feed[0].agentId).toBe("agt_1");
    expect((await service.getTask(task.id))?.status).toBe("in_progress");
  });
  /** A daemon restart re-arms the observer, but the agent it watches may have
   * been mid-run: it will reach idle without this observer having seen it run,
   * and the settle that moves the card would never fire. */
  it("settles an agent that was already running when the observer was armed", async () => {
    const { task, engine, agentManager, projectId } = await seedTask();
    agentManager.snapshots.set("agt_1", "running");

    engine.observeAttachment({ taskId: task.id, agentId: "agt_1" });
    agentManager.emitLifecycle("agt_1", "idle");

    await vi.waitFor(async () => {
      expect((await service.getTask(task.id))?.status).toBe("done");
    });
    void projectId;
  });

  /** An attached agent waiting between turns is the ordinary state, not a
   * finish: arming an observer on it must move nothing. */
  it("leaves a task alone when the agent it re-arms on is merely idle", async () => {
    const { task, engine, agentManager } = await seedTask();
    agentManager.snapshots.set("agt_1", "idle");

    engine.observeAttachment({ taskId: task.id, agentId: "agt_1" });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect((await service.getTask(task.id))?.status).toBe("in_progress");
  });
});
