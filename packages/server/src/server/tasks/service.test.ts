import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
});
