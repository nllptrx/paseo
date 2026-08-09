import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Step } from "@getpaseo/protocol/tasks/workflow";
import { TaskService } from "./service.js";

const logger = pino({ level: "silent" });

describe("TaskService", () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "paseo-task-service-"));
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  function createService(fileName = "tasks.db"): TaskService {
    return new TaskService({ databasePath: join(directory, fileName), logger });
  }

  it("opens the store on first use, not on construction", async () => {
    const service = createService();
    expect(await service.isAvailable()).toBe(true);
    await service.close();
  });

  it("announces the new revision to listeners after a write", async () => {
    const service = createService();
    const seen: number[] = [];
    service.onRevision((revision) => seen.push(revision));

    const project = await service.createProject({ name: "Paseo", prefix: "PSE", color: "#fff" });
    await service.createTask({ projectId: project.id, title: "Watched" });

    expect(seen).toHaveLength(2);
    expect(seen[1]).toBeGreaterThan(seen[0] as number);
    await service.close();
  });

  it("keeps announcing after one listener throws", async () => {
    const service = createService();
    const seen: number[] = [];
    service.onRevision(() => {
      throw new Error("listener exploded");
    });
    service.onRevision((revision) => seen.push(revision));

    await service.createProject({ name: "Paseo", prefix: "PSE", color: "#fff" });

    expect(seen).toHaveLength(1);
    await service.close();
  });

  it("stops announcing to a listener that unsubscribed", async () => {
    const service = createService();
    const seen: number[] = [];
    const stop = service.onRevision((revision) => seen.push(revision));

    await service.createProject({ name: "Paseo", prefix: "PSE", color: "#fff" });
    stop();
    await service.createProject({ name: "Relay", prefix: "RLY", color: "#000" });

    expect(seen).toHaveLength(1);
    await service.close();
  });

  /**
   * An unopenable tracker must not take the daemon with it, and must not be
   * retried on every request — the failure is not transient.
   */
  it("reports itself unavailable when the database cannot be opened", async () => {
    const path = join(directory, "broken.db");
    writeFileSync(path, "this is not a database");
    const service = new TaskService({ databasePath: path, logger });

    expect(await service.isAvailable()).toBe(false);
    await expect(service.snapshot()).rejects.toThrow();
    expect(await service.isAvailable()).toBe(false);
  });

  it("carries a task through create, move and delete", async () => {
    const service = createService();
    const project = await service.createProject({ name: "Paseo", prefix: "PSE", color: "#fff" });
    const task = await service.createTask({ projectId: project.id, title: "Ship it" });

    expect(task.number).toBe(1);
    expect(task.status).toBe("backlog");

    const moved = await service.moveTask({
      taskId: task.id,
      status: "in_progress",
      beforePosition: null,
      afterPosition: null,
    });
    expect(moved.status).toBe("in_progress");

    await service.deleteTask(task.id);
    expect((await service.snapshot()).tasks).toEqual([]);
    await service.close();
  });

  it("routes both task updates and board drops to the completion gate", async () => {
    const service = createService();
    const project = await service.createProject({ name: "Paseo", prefix: "PSE", color: "#fff" });
    const first = await service.createTask({ projectId: project.id, title: "First" });
    const second = await service.createTask({ projectId: project.id, title: "Second" });
    const gated: string[] = [];
    service.setCompleteTaskHandler(async (taskId) => {
      gated.push(taskId);
      return await service.finalizeTaskDone(taskId);
    });

    await service.updateTask({ taskId: first.id, status: "done" });
    await service.moveTask({
      taskId: second.id,
      status: "done",
      beforePosition: null,
      afterPosition: null,
    });

    expect(gated).toEqual([first.id, second.id]);
    expect((await service.getTask(first.id))?.status).toBe("done");
    expect((await service.getTask(second.id))?.status).toBe("done");
    await service.close();
  });

  it("does not apply a Done drop when the completion gate keeps the task active", async () => {
    const service = createService();
    const project = await service.createProject({ name: "Paseo", prefix: "PSE", color: "#fff" });
    const task = await service.createTask({
      projectId: project.id,
      title: "Conflicted",
      status: "in_progress",
    });
    service.setCompleteTaskHandler(async (taskId) => {
      const current = await service.getTask(taskId);
      if (!current) throw new Error("missing test task");
      return current;
    });

    const result = await service.moveTask({
      taskId: task.id,
      status: "done",
      beforePosition: null,
      afterPosition: null,
    });

    expect(result.status).toBe("in_progress");
    expect((await service.getTask(task.id))?.status).toBe("in_progress");
    await service.close();
  });

  it("refuses to create an already-complete subtask", async () => {
    const service = createService();
    const project = await service.createProject({ name: "Paseo", prefix: "PSE", color: "#fff" });
    const parent = await service.createTask({ projectId: project.id, title: "Parent" });

    await expect(
      service.createTask({
        projectId: project.id,
        parentTaskId: parent.id,
        title: "Child",
        status: "done",
      }),
    ).rejects.toThrow(/cannot be created as Done/);
    await service.close();
  });
  /** The gate is what "claiming" means: a task waiting on something unfinished
   * refuses the attachment rather than letting two agents race the order. */
  it("refuses to attach an agent to a task whose blockers are open", async () => {
    const service = new TaskService({ databasePath: join(directory, "tasks.db"), logger });
    try {
      const project = await service.createProject({ name: "P", prefix: "P", color: "#fff" });
      const blocked = await service.createTask({ projectId: project.id, title: "Second" });
      const blocker = await service.createTask({ projectId: project.id, title: "First" });
      await service.addDependency({ taskId: blocked.id, dependsOnTaskId: blocker.id });

      await expect(
        service.attachAgent({ taskId: blocked.id, agentId: "agt_1", workspaceId: "ws_1" }),
      ).rejects.toThrow(/blocked by/);

      await service.updateTask({ taskId: blocker.id, status: "done" });
      await expect(
        service.attachAgent({ taskId: blocked.id, agentId: "agt_1", workspaceId: "ws_1" }),
      ).resolves.toBeUndefined();
    } finally {
      await service.close();
    }
  });

  it("reports the blockers a task is still waiting on", async () => {
    const service = new TaskService({ databasePath: join(directory, "tasks.db"), logger });
    try {
      const project = await service.createProject({ name: "P", prefix: "P", color: "#fff" });
      const blocked = await service.createTask({ projectId: project.id, title: "Second" });
      const open = await service.createTask({ projectId: project.id, title: "Open" });
      const dropped = await service.createTask({ projectId: project.id, title: "Canceled" });
      await service.addDependency({ taskId: blocked.id, dependsOnTaskId: open.id });
      await service.addDependency({ taskId: blocked.id, dependsOnTaskId: dropped.id });
      await service.updateTask({ taskId: dropped.id, status: "canceled" });

      expect((await service.listBlockers(blocked.id)).map((task) => task.title)).toEqual(["Open"]);
    } finally {
      await service.close();
    }
  });

  it("refuses scheduled workflow fan-out until the scheduler can represent it", async () => {
    const service = createService();
    const project = await service.createProject({ name: "P", prefix: "P", color: "#fff" });
    const task = await service.createTask({ projectId: project.id, title: "Scheduled" });
    const step: Step = {
      id: "stp_1",
      name: "Scheduled step",
      prompt: "Run it",
      agents: [{ provider: "claude" }, { provider: "codex" }],
      completion: "all",
      workspace: { mode: "existing", workspaceId: "ws_1" },
      trigger: { type: "schedule", cadence: { type: "every", everyMs: 60_000 } },
      runs: [],
    };

    await expect(service.setWorkflow({ taskId: task.id, steps: [step] })).rejects.toThrow(
      /exactly one agent/,
    );
    expect(await service.getWorkflow(task.id)).toBeNull();
    await service.close();
  });
  /** The board has to be true while work runs, not only after it. Starting from
   * Backlog and jumping to Done would never have shown the work happening. */
  it("moves a card to Working when an agent starts on it", async () => {
    const service = new TaskService({ databasePath: join(directory, "tasks.db"), logger });
    try {
      const project = await service.createProject({ name: "P", prefix: "P", color: "#fff" });
      const task = await service.createTask({ projectId: project.id, title: "Ship it" });
      expect(task.status).toBe("backlog");

      await service.attachAgent({ taskId: task.id, agentId: "agt_1", workspaceId: "ws_1" });

      expect((await service.getTask(task.id))?.status).toBe("in_progress");
      const feed = await service.listBoardFeed({ projectId: project.id });
      expect(feed.at(-1)?.body).toContain("moved to Working");
    } finally {
      await service.close();
    }
  });

  /** A card already in Review says something more specific than Working; a
   * second agent attaching must not drag it backwards. */
  it("leaves a card that is past Working where it is", async () => {
    const service = new TaskService({ databasePath: join(directory, "tasks.db"), logger });
    try {
      const project = await service.createProject({ name: "P", prefix: "P", color: "#fff" });
      const task = await service.createTask({ projectId: project.id, title: "Ship it" });
      await service.updateTask({ taskId: task.id, status: "in_review" });

      await service.attachAgent({ taskId: task.id, agentId: "agt_1", workspaceId: "ws_1" });

      expect((await service.getTask(task.id))?.status).toBe("in_review");
    } finally {
      await service.close();
    }
  });
});
