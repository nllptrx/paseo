import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { KanbanSummary } from "@getpaseo/protocol/kanban/types";
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
    getAgent: () => null,
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

function boardSummary(input: {
  projectId: string;
  review?: KanbanSummary["review"];
  archivedAt?: string | null;
}): KanbanSummary {
  return {
    id: `kb_${input.projectId}`,
    projectId: input.projectId,
    name: "Board",
    archiveWorkspacesOnDone: false,
    ...(input.review ? { review: input.review } : {}),
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    archivedAt: input.archivedAt ?? null,
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

  async function seedTask(input?: { review?: KanbanSummary["review"] }) {
    const boardNotes: string[] = [];
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
    const kanbans = [boardSummary({ projectId: "proj-1", review: input?.review })];
    const agentManager = createFakeAgentManager();
    const engine = new TaskTransitionEngine({
      taskService: service,
      listKanbans: async () => kanbans,
      agentManager,
      notifyBoard: ({ note }) => {
        boardNotes.push(note);
      },
      logger,
    });
    return { task, engine, agentManager, boardNotes };
  }

  it("moves a task to done when work settles and the board does not review", async () => {
    const { task, engine, boardNotes } = await seedTask();
    await engine.onWorkSettled(task.id);
    expect((await service.getTask(task.id))?.status).toBe("done");
    expect(boardNotes).toEqual([
      `Task PSE-1 "Ship it" settled its attached work and moved to done.`,
    ]);
  });

  it("moves a task to in_review when the board reviews", async () => {
    const { task, engine } = await seedTask({
      review: { enabled: true, onReject: "in_progress" },
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
    const { task, engine } = await seedTask({ review: { enabled: true, onReject: "todo" } });
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
});
