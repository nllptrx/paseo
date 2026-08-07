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

  async function seedTask(input?: { review?: TaskBoardConfig }) {
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
    });
    return { task, engine, agentManager, projectId: project.id };
  }

  it("moves a task to done when work settles and the board does not review", async () => {
    const { task, engine, projectId } = await seedTask();
    await engine.onWorkSettled(task.id);
    expect((await service.getTask(task.id))?.status).toBe("done");

    const feed = await service.listBoardFeed({ projectId });
    expect(feed.map((entry) => ({ kind: entry.kind, body: entry.body }))).toEqual([
      { kind: "system", body: `PSE-1 "Ship it" settled its attached work and moved to done.` },
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

  it("leaves done and canceled tasks alone", async () => {
    const { task, engine } = await seedTask();
    await service.updateTask({ taskId: task.id, status: "canceled" });
    await engine.onWorkSettled(task.id);
    expect((await service.getTask(task.id))?.status).toBe("canceled");
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
