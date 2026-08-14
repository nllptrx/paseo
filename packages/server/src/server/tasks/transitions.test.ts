import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskBoardConfig, TaskComment } from "@getpaseo/protocol/tasks/types";
import type { ManagedAgent } from "../agent/agent-manager.js";
import { isReviewVerdictEvent } from "./board-events.js";
import { REVIEW_APPROVED_NOTE, REVIEW_REJECTED_NOTE } from "./review-verdict-notes.js";
import { TaskService } from "./service.js";
import { REVIEWER_FINDINGS_EXCERPT_LIMIT, TaskTransitionEngine } from "./transitions.js";

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
    lastMessages: new Map<string, string>(),
    lastMessageError: null as Error | null,
    async getLastAssistantMessage(agentId: string): Promise<string | null> {
      if (this.lastMessageError) {
        throw this.lastMessageError;
      }
      return this.lastMessages.get(agentId) ?? null;
    },
    getAgent(agentId: string) {
      const lifecycle = this.snapshots.get(agentId);
      return lifecycle ? ({ lifecycle, pendingPermissions: new Map() } as ManagedAgent) : null;
    },
    emitLifecycle(agentId: string, lifecycle: ManagedAgent["lifecycle"]) {
      this.snapshots.set(agentId, lifecycle);
      for (const listener of listeners.get(agentId) ?? []) {
        listener({ type: "agent_state", agent: { lifecycle, pendingPermissions: new Map() } });
      }
    },
    emitPendingPermissions(agentId: string, pending: number) {
      const lifecycle = this.snapshots.get(agentId) ?? "running";
      const pendingPermissions = new Map(
        Array.from({ length: pending }, (_unused, index) => [`req_${index}`, {}] as const),
      );
      for (const listener of listeners.get(agentId) ?? []) {
        listener({ type: "agent_state", agent: { lifecycle, pendingPermissions } });
      }
    },
    listenerCount(agentId: string): number {
      return listeners.get(agentId)?.size ?? 0;
    },
  };
}

/** Kept out of the tests so an assertion inside `waitFor` stays one callback
 * deep. */
function indexOfEntryContaining(feed: readonly TaskComment[], needle: string): number {
  return feed.findIndex((entry) => entry.body.includes(needle));
}

describe("TaskTransitionEngine", () => {
  let directory: string;
  let service: TaskService;

  async function listWaitingEntries(projectId: string): Promise<readonly TaskComment[]> {
    const feed = await service.listBoardFeed({ projectId });
    return feed.filter((entry) => entry.event?.kind === "agent_needs_input");
  }

  async function countWaitingEntries(projectId: string): Promise<number> {
    return (await listWaitingEntries(projectId)).length;
  }

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
    service.setBoardEventListener((event) => engine.handleBoardEvent(event));
    return { task, engine, agentManager, projectId: project.id };
  }

  async function feedText(projectId: string): Promise<string> {
    const feed = await service.listBoardFeed({ projectId });
    return feed.map((entry) => entry.body).join("\n");
  }

  /** Done means somebody accepted the work. A board without a reviewer parks
   * the card in review for a person instead of calling it finished. */
  it("moves a root task to in_review for a human when the board does not review", async () => {
    const { task, engine, projectId } = await seedTask();
    const reviews: string[] = [];
    engine.setRequestReview(async (taskId) => {
      reviews.push(taskId);
      return null;
    });
    await engine.onWorkSettled(task.id);
    expect((await service.getTask(task.id))?.status).toBe("in_review");
    expect(reviews).toEqual([]);

    const feed = (await service.listBoardFeed({ projectId })).filter(
      (entry) => entry.event?.kind !== "task_created",
    );
    expect(feed.map((entry) => ({ kind: entry.kind, body: entry.body }))).toEqual([
      {
        kind: "system",
        body: `PSE-1 "Ship it" settled its attached work and moved to in_review to await a verdict.`,
      },
    ]);
    expect(feed[0].taskId).toBe(task.id);
  });

  /** A board with a reviewer must review what a hand drops into review, not
   * only what automation carries there. */
  it("arms the reviewer when a card is moved into review by hand", async () => {
    const { task, engine } = await seedTask({
      review: {
        reviewEnabled: true,
        reviewOnReject: "in_progress",
        archiveWorkspacesOnDone: false,
      },
    });
    const reviews: string[] = [];
    engine.setRequestReview(async (taskId) => {
      reviews.push(taskId);
      return { agentId: "reviewer-1" };
    });
    service.setReviewEntryHandler((taskId) => engine.startReviewIfIdle(taskId));

    await service.moveTask({
      taskId: task.id,
      status: "in_review",
      beforePosition: null,
      afterPosition: null,
    });

    await vi.waitFor(() => expect(reviews).toEqual([task.id]));
  });

  /** A reviewer already judging the card is left alone. */
  it("does not start a second reviewer when one is already working", async () => {
    const { task, engine, agentManager } = await seedTask({
      review: {
        reviewEnabled: true,
        reviewOnReject: "in_progress",
        archiveWorkspacesOnDone: false,
      },
    });
    const reviews: string[] = [];
    engine.setRequestReview(async (taskId) => {
      reviews.push(taskId);
      return { agentId: "reviewer-2" };
    });
    await service.updateTask({ taskId: task.id, status: "in_review" });
    await service.attachAgent({
      taskId: task.id,
      agentId: "reviewer-1",
      workspaceId: "ws-1",
      role: "reviewer",
    });
    agentManager.snapshots.set("reviewer-1", "running");

    await engine.startReviewIfIdle(task.id);

    expect(reviews).toEqual([]);
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

  it("moves a parent to in_progress when its first subtask starts", async () => {
    const { engine, projectId } = await seedTask();
    void engine;
    const parent = await service.createTask({ projectId, title: "Parent", status: "todo" });
    const child = await service.createTask({
      projectId,
      parentTaskId: parent.id,
      title: "First phase",
    });

    await service.updateTask({ taskId: child.id, status: "in_progress" });

    await vi.waitFor(async () =>
      expect((await service.getTask(parent.id))?.status).toBe("in_progress"),
    );
    expect(await feedText(projectId)).toContain(
      `moved to in_progress: its subtask PSE-${child.number} started`,
    );
  });

  it("moves a parent to in_review when its last subtask merges and its policy reviews", async () => {
    const { engine, projectId } = await seedTask({
      review: {
        reviewEnabled: true,
        reviewOnReject: "in_progress",
        archiveWorkspacesOnDone: false,
      },
    });
    void engine;
    const parent = await service.createTask({ projectId, title: "Parent", status: "in_progress" });
    const first = await service.createTask({ projectId, parentTaskId: parent.id, title: "One" });
    const second = await service.createTask({ projectId, parentTaskId: parent.id, title: "Two" });

    await service.updateTask({ taskId: first.id, status: "done" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await service.getTask(parent.id))?.status).toBe("in_progress");

    await service.updateTask({ taskId: second.id, status: "done" });

    await vi.waitFor(async () =>
      expect((await service.getTask(parent.id))?.status).toBe("in_review"),
    );
    expect(await feedText(projectId)).toContain(
      `moved to in_review: its last subtask PSE-${second.number} merged`,
    );
  });

  /** The aggregate is the human gate of its chain: with no reviewer configured
   * it waits for a verdict rather than calling the delivery accepted. */
  it("parks a parent in review for a human once its subtasks have merged", async () => {
    const { engine, projectId } = await seedTask();
    void engine;
    const parent = await service.createTask({ projectId, title: "Parent", status: "in_progress" });
    const child = await service.createTask({ projectId, parentTaskId: parent.id, title: "Only" });

    await service.updateTask({ taskId: child.id, status: "done" });

    await vi.waitFor(async () =>
      expect((await service.getTask(parent.id))?.status).toBe("in_review"),
    );
  });

  /** Nothing was delivered, so calling the parent finished would be a claim its
   * children never made. */
  it("leaves a parent alone when every subtask was canceled", async () => {
    const { engine, projectId } = await seedTask();
    void engine;
    const parent = await service.createTask({ projectId, title: "Parent", status: "in_progress" });
    const child = await service.createTask({ projectId, parentTaskId: parent.id, title: "Only" });

    await service.updateTask({ taskId: child.id, status: "canceled" });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect((await service.getTask(parent.id))?.status).toBe("in_progress");
  });

  it("reviews a subtask because its parent's plan asks for it", async () => {
    const { engine, projectId } = await seedTask();
    const parent = await service.createTask({
      projectId,
      title: "Parent",
      executionPolicy: { subtaskReview: "required" },
    });
    const child = await service.createTask({
      projectId,
      parentTaskId: parent.id,
      title: "Phase",
      status: "in_progress",
    });

    await engine.onWorkSettled(child.id);

    expect((await service.getTask(child.id))?.status).toBe("in_review");
  });

  it("keeps subtasks out of review when the parent asks for a final review only", async () => {
    const { engine, projectId } = await seedTask({
      review: {
        reviewEnabled: true,
        reviewOnReject: "in_progress",
        archiveWorkspacesOnDone: false,
      },
    });
    const parent = await service.createTask({
      projectId,
      title: "Parent",
      executionPolicy: { review: "required", subtaskReview: "disabled" },
    });
    const child = await service.createTask({
      projectId,
      parentTaskId: parent.id,
      title: "Phase",
      status: "in_progress",
    });

    await engine.onWorkSettled(child.id);

    expect((await service.getTask(child.id))?.status).toBe("done");
    await vi.waitFor(async () =>
      expect((await service.getTask(parent.id))?.status).toBe("in_review"),
    );
  });

  it("starts a waiting task from its execution spec when its last blocker settles", async () => {
    const { engine, projectId } = await seedTask();
    const blocker = await service.createTask({ projectId, title: "First", status: "in_progress" });
    const next = await service.createTask({
      projectId,
      title: "Second",
      executionSpec: { presetId: "tpst_impl", trigger: "on_unblocked" },
    });
    await service.addDependency({ taskId: next.id, dependsOnTaskId: blocker.id });
    const delegations: Array<{ taskId: string; presetId: string }> = [];
    engine.setRequestDelegation(async (input) => {
      delegations.push(input);
      return { agentId: "agt_next" };
    });

    await service.updateTask({ taskId: blocker.id, status: "done" });

    await vi.waitFor(() =>
      expect(delegations).toEqual([{ taskId: next.id, presetId: "tpst_impl" }]),
    );
    expect(await feedText(projectId)).toContain("started automatically: its last blocker settled");
  });

  it("waits for every blocker before starting a task from its execution spec", async () => {
    const { engine, projectId } = await seedTask();
    const first = await service.createTask({ projectId, title: "First", status: "in_progress" });
    const second = await service.createTask({ projectId, title: "Second", status: "in_progress" });
    const next = await service.createTask({
      projectId,
      title: "Third",
      executionSpec: { presetId: "tpst_impl", trigger: "on_unblocked" },
    });
    await service.addDependency({ taskId: next.id, dependsOnTaskId: first.id });
    await service.addDependency({ taskId: next.id, dependsOnTaskId: second.id });
    const delegations: Array<{ taskId: string; presetId: string }> = [];
    engine.setRequestDelegation(async (input) => {
      delegations.push(input);
      return { agentId: "agt_next" };
    });

    await service.updateTask({ taskId: first.id, status: "done" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(delegations).toEqual([]);

    await service.updateTask({ taskId: second.id, status: "canceled" });

    await vi.waitFor(() => expect(delegations).toHaveLength(1));
  });

  /**
   * Two blockers of one task reporting settled together must start it once, not
   * twice. The settles are reported directly rather than through two stored
   * writes: a write lets the first report finish before the second lands, which
   * is the easy case, while reporting both at once is what puts the two dispatch
   * attempts in flight over the same task.
   */
  it("starts a task once when two blockers report settled together", async () => {
    const { engine, projectId } = await seedTask();
    const first = await service.createTask({ projectId, title: "First", status: "in_progress" });
    const second = await service.createTask({ projectId, title: "Second", status: "in_progress" });
    const next = await service.createTask({
      projectId,
      title: "Third",
      executionSpec: { presetId: "tpst_impl", trigger: "on_unblocked" },
    });
    await service.addDependency({ taskId: next.id, dependsOnTaskId: first.id });
    await service.addDependency({ taskId: next.id, dependsOnTaskId: second.id });
    const delegations: Array<{ taskId: string; presetId: string }> = [];
    engine.setRequestDelegation(async (input) => {
      delegations.push(input);
      return { agentId: `agt_${delegations.length}` };
    });
    service.setBoardEventListener(() => undefined);
    await service.updateTask({ taskId: first.id, status: "done" });
    await service.updateTask({ taskId: second.id, status: "done" });

    for (const blocker of [first, second]) {
      engine.handleBoardEvent({
        kind: "task_moved",
        taskId: blocker.id,
        parentTaskId: null,
        previousStatus: "in_progress",
        status: "done",
        cause: "settled",
      });
    }

    await vi.waitFor(() =>
      expect(delegations).toEqual([{ taskId: next.id, presetId: "tpst_impl" }]),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(delegations).toHaveLength(1);
  });

  /** A blocker that settles while the daemon is down leaves its dependent ready
   * and unstarted: the trigger fires on a status change that already happened. */
  it("starts a task whose blocker settled while the daemon was down", async () => {
    const { engine, projectId } = await seedTask();
    const blocker = await service.createTask({ projectId, title: "First", status: "in_progress" });
    const next = await service.createTask({
      projectId,
      title: "Second",
      executionSpec: { presetId: "tpst_impl", trigger: "on_unblocked" },
    });
    await service.addDependency({ taskId: next.id, dependsOnTaskId: blocker.id });
    await service.updateTask({ taskId: blocker.id, status: "done" });
    const delegations: Array<{ taskId: string; presetId: string }> = [];
    engine.setRequestDelegation(async (input) => {
      delegations.push(input);
      return { agentId: "agt_next" };
    });

    await engine.start();

    expect(delegations).toEqual([{ taskId: next.id, presetId: "tpst_impl" }]);
  });

  it("does not restart a task that already has the agent its spec asked for", async () => {
    const { engine, projectId } = await seedTask();
    const blocker = await service.createTask({ projectId, title: "First", status: "in_progress" });
    const next = await service.createTask({
      projectId,
      title: "Second",
      executionSpec: { presetId: "tpst_impl", trigger: "on_unblocked" },
    });
    await service.addDependency({ taskId: next.id, dependsOnTaskId: blocker.id });
    await service.updateTask({ taskId: blocker.id, status: "done" });
    await service.attachAgent({ taskId: next.id, agentId: "agt_running", workspaceId: "ws_1" });
    const delegations: Array<{ taskId: string; presetId: string }> = [];
    engine.setRequestDelegation(async (input) => {
      delegations.push(input);
      return { agentId: "agt_next" };
    });

    await engine.start();

    expect(delegations).toEqual([]);
  });

  /** A subtask captured straight into a working status is the same event as one
   * moved there, so the parent has to see it. */
  it("moves a parent from a subtask created directly in progress", async () => {
    const { engine, projectId } = await seedTask();
    void engine;
    const parent = await service.createTask({ projectId, title: "Parent", status: "todo" });

    await service.createTask({
      projectId,
      parentTaskId: parent.id,
      title: "Phase",
      status: "in_progress",
    });

    await vi.waitFor(async () =>
      expect((await service.getTask(parent.id))?.status).toBe("in_progress"),
    );
  });

  it("starts a waiting task from a blocker created already canceled", async () => {
    const { engine, projectId } = await seedTask();
    const next = await service.createTask({
      projectId,
      title: "Second",
      executionSpec: { presetId: "tpst_impl", trigger: "on_unblocked" },
    });
    const delegations: Array<{ taskId: string; presetId: string }> = [];
    engine.setRequestDelegation(async (input) => {
      delegations.push(input);
      return { agentId: "agt_next" };
    });
    const blocker = await service.createTask({
      projectId,
      title: "Skipped",
      status: "in_progress",
    });
    await service.addDependency({ taskId: next.id, dependsOnTaskId: blocker.id });

    await service.updateTask({ taskId: blocker.id, status: "canceled" });

    await vi.waitFor(() => expect(delegations).toHaveLength(1));
  });

  /** The aggregate's final review is handed its children's verdicts read back
   * out of the feed, so the verdict wording is a contract, not prose. */
  it("marks an approval and a rejection in the feed as review verdicts", async () => {
    const { task, engine, projectId } = await seedTask({
      review: {
        reviewEnabled: true,
        reviewOnReject: "in_progress",
        archiveWorkspacesOnDone: false,
      },
    });
    engine.setRequestCorrection(async () => ({ agentIds: ["worker"] }));
    await service.updateTask({ taskId: task.id, status: "in_review" });
    await engine.applyReviewVerdict({ taskId: task.id, verdict: "reject", feedback: "Again" });
    await service.updateTask({ taskId: task.id, status: "in_review" });
    await engine.applyReviewVerdict({ taskId: task.id, verdict: "approve" });

    const verdicts = (await service.listBoardFeed({ projectId }))
      .filter((entry) => entry.taskId === task.id && isReviewVerdictEvent(entry.event))
      .map((entry) => entry.body);

    expect(verdicts).toHaveLength(2);
    expect(verdicts.some((body) => body.includes(REVIEW_REJECTED_NOTE))).toBe(true);
    expect(verdicts.some((body) => body.includes(REVIEW_APPROVED_NOTE))).toBe(true);
  });

  it("leaves a task without an on_unblocked trigger for a hand to start", async () => {
    const { engine, projectId } = await seedTask();
    const blocker = await service.createTask({ projectId, title: "First", status: "in_progress" });
    const next = await service.createTask({
      projectId,
      title: "Second",
      executionSpec: { presetId: "tpst_impl", trigger: "manual" },
    });
    await service.addDependency({ taskId: next.id, dependsOnTaskId: blocker.id });
    const delegations: Array<{ taskId: string; presetId: string }> = [];
    engine.setRequestDelegation(async (input) => {
      delegations.push(input);
      return { agentId: "agt_next" };
    });

    await service.updateTask({ taskId: blocker.id, status: "done" });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(delegations).toEqual([]);
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

  /** The override turns the agent reviewer off; the root still waits for a
   * person, because Done is a verdict. */
  it("lets one task trade the agent reviewer for a human on a reviewing board", async () => {
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
    const reviews: string[] = [];
    engine.setRequestReview(async (taskId) => {
      reviews.push(taskId);
      return null;
    });

    await engine.onWorkSettled(task.id);

    expect((await service.getTask(task.id))?.status).toBe("in_review");
    expect(reviews).toEqual([]);
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
    expect((await service.getTask(task.id))?.status).toBe("in_review");
  });

  it("keeps observing across turns: a second finish moves a task pushed back to work", async () => {
    const { task, engine, agentManager } = await seedTask();
    engine.observeAttachment({ taskId: task.id, agentId: "agent-1" });

    agentManager.emitLifecycle("agent-1", "running");
    agentManager.emitLifecycle("agent-1", "idle");
    await new Promise((resolve) => setImmediate(resolve));
    expect((await service.getTask(task.id))?.status).toBe("in_review");

    await service.updateTask({ taskId: task.id, status: "in_progress" });
    agentManager.emitLifecycle("agent-1", "running");
    agentManager.emitLifecycle("agent-1", "idle");
    await new Promise((resolve) => setImmediate(resolve));
    expect((await service.getTask(task.id))?.status).toBe("in_review");
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
    expect((await service.getTask(task.id))?.status).toBe("in_review");
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

  /** Findings that stayed in the reviewer's chat reach nobody. In the feed a
   * human can turn them into a rejection, which is what gets them to the
   * workers. */
  it("posts the last message of a reviewer that ended without a verdict", async () => {
    const { task, engine, agentManager, projectId } = await seedTask({
      review: {
        reviewEnabled: true,
        reviewOnReject: "in_progress",
        archiveWorkspacesOnDone: false,
      },
      maxReviewAttempts: 1,
    });
    engine.setRequestReview(async () => ({ agentId: "reviewer-1" }));
    agentManager.lastMessages.set("reviewer-1", "The migration drops a column without a backup.");

    await engine.onWorkSettled(task.id);
    agentManager.emitLifecycle("reviewer-1", "running");
    agentManager.emitLifecycle("reviewer-1", "idle");

    await vi.waitFor(async () => {
      const feed = await service.listBoardFeed({ projectId });
      const findingsIndex = indexOfEntryContaining(feed, "never became a verdict");
      expect(feed[findingsIndex]?.body).toContain("The migration drops a column without a backup.");
      expect(feed[findingsIndex]?.agentId).toBe("reviewer-1");
      expect(findingsIndex).toBeGreaterThanOrEqual(0);
      expect(findingsIndex).toBeLessThan(
        indexOfEntryContaining(feed, "without recording a verdict"),
      );
    });
  });

  it("truncates a long reviewer message and says it was truncated", async () => {
    const { task, engine, agentManager, projectId } = await seedTask({
      review: {
        reviewEnabled: true,
        reviewOnReject: "in_progress",
        archiveWorkspacesOnDone: false,
      },
      maxReviewAttempts: 1,
    });
    engine.setRequestReview(async () => ({ agentId: "reviewer-1" }));
    agentManager.lastMessages.set(
      "reviewer-1",
      "x".repeat(REVIEWER_FINDINGS_EXCERPT_LIMIT + 500) + "TAIL",
    );

    await engine.onWorkSettled(task.id);
    agentManager.emitLifecycle("reviewer-1", "running");
    agentManager.emitLifecycle("reviewer-1", "idle");

    await vi.waitFor(async () => {
      const feed = await service.listBoardFeed({ projectId });
      const findings = feed[indexOfEntryContaining(feed, "never became a verdict")];
      expect(findings?.body).toContain(`truncated to the first ${REVIEWER_FINDINGS_EXCERPT_LIMIT}`);
      expect(findings?.body).not.toContain("TAIL");
    });
  });

  /** Saying nothing would read as "the reviewer found nothing", and the card
   * still has to be handed on. */
  it("says so in the feed when the reviewer's last message cannot be read", async () => {
    const { task, engine, agentManager, projectId } = await seedTask({
      review: {
        reviewEnabled: true,
        reviewOnReject: "in_progress",
        archiveWorkspacesOnDone: false,
      },
      maxReviewAttempts: 1,
    });
    engine.setRequestReview(async () => ({ agentId: "reviewer-1" }));
    agentManager.lastMessageError = new Error("chat storage is closed");

    await engine.onWorkSettled(task.id);
    agentManager.emitLifecycle("reviewer-1", "running");
    agentManager.emitLifecycle("reviewer-1", "idle");

    await vi.waitFor(async () => {
      expect(await feedText(projectId)).toContain(
        "The reviewer's findings could not be read from its chat; open the reviewer agent to see them.",
      );
    });
    expect((await service.getTask(task.id))?.status).toBe("in_review");
  });

  /** Null is not a failure: it is a chat the daemon no longer holds, and the
   * feed must name that cause, not a read error that never happened. */
  it("says the chat is no longer loaded when the reviewer's message is gone", async () => {
    const { task, engine, agentManager, projectId } = await seedTask({
      review: {
        reviewEnabled: true,
        reviewOnReject: "in_progress",
        archiveWorkspacesOnDone: false,
      },
      maxReviewAttempts: 1,
    });
    engine.setRequestReview(async () => ({ agentId: "reviewer-1" }));

    await engine.onWorkSettled(task.id);
    agentManager.emitLifecycle("reviewer-1", "running");
    agentManager.emitLifecycle("reviewer-1", "idle");

    await vi.waitFor(async () => {
      expect(await feedText(projectId)).toContain(
        "could not be read because its chat is no longer loaded",
      );
    });
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
    expect((await service.getTask(task.id))?.status).toBe("in_review");
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
    const stalled = feed.find((entry) => entry.event?.kind === "agent_stalled");
    expect(stalled?.kind).toBe("system");
    expect(stalled?.body).toContain("stopped on an error");
    expect(stalled?.agentId).toBe("agt_1");
    expect((await service.getTask(task.id))?.status).toBe("in_progress");
  });
  it("records an agent waiting on a permission once, not on every state event", async () => {
    const { task, engine, agentManager, projectId } = await seedTask();
    engine.observeAttachment({ taskId: task.id, agentId: "agt_1" });

    agentManager.emitLifecycle("agt_1", "running");
    agentManager.emitPendingPermissions("agt_1", 1);
    agentManager.emitPendingPermissions("agt_1", 1);
    await vi.waitFor(async () => {
      expect(await countWaitingEntries(projectId)).toBe(1);
    });

    const waiting = await listWaitingEntries(projectId);
    expect(waiting).toHaveLength(1);
    expect(waiting[0]?.body).toContain("waiting for a permission decision");
    expect(waiting[0]?.agentId).toBe("agt_1");
    expect((await service.getTask(task.id))?.status).toBe("in_progress");
  });

  it("records the next wait after the agent stops waiting", async () => {
    const { task, engine, agentManager, projectId } = await seedTask();
    engine.observeAttachment({ taskId: task.id, agentId: "agt_1" });

    agentManager.emitLifecycle("agt_1", "running");
    agentManager.emitPendingPermissions("agt_1", 1);
    agentManager.emitPendingPermissions("agt_1", 0);
    agentManager.emitPendingPermissions("agt_1", 2);
    await vi.waitFor(async () => {
      expect(await countWaitingEntries(projectId)).toBe(2);
    });

    const waiting = await listWaitingEntries(projectId);
    expect(waiting.map((entry) => entry.body).join(" ")).toContain("2 permission decisions");
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
      expect((await service.getTask(task.id))?.status).toBe("in_review");
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
