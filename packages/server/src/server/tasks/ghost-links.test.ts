import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { StoredAgentRecord } from "../agent/agent-storage.js";
import { pruneGhostAgentLinks } from "./ghost-links.js";
import { TaskService } from "./service.js";

const logger = pino({ level: "silent" });

/** Only the fields the sweep reads: an id and whether the record is archived. */
function storedAgent(id: string, archivedAt: string | null = null): StoredAgentRecord {
  return { id, ...(archivedAt ? { archivedAt } : {}) } as StoredAgentRecord;
}

const FUTURE_CUTOFF = "2999-01-01T00:00:00.000Z";

describe("pruneGhostAgentLinks", () => {
  let directory: string;
  let service: TaskService;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "paseo-task-ghost-links-"));
    service = new TaskService({ databasePath: join(directory, "tasks.db"), logger });
  });

  afterEach(async () => {
    await service.close();
    rmSync(directory, { recursive: true, force: true });
  });

  async function seedTask() {
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
    return { projectId: project.id, taskId: task.id };
  }

  it("removes the link of an agent that no longer exists", async () => {
    const { taskId } = await seedTask();
    await service.attachAgent({ taskId, agentId: "agt_gone", workspaceId: "ws-1" });

    const pruned = await pruneGhostAgentLinks({
      taskService: service,
      agentStorage: { list: async () => [] },
      logger,
      attachedBefore: FUTURE_CUTOFF,
    });

    expect(pruned).toEqual(["agt_gone"]);
    expect(await service.listTaskAgents(taskId)).toEqual([]);
  });

  it("removes the link of an archived agent", async () => {
    const { taskId } = await seedTask();
    await service.attachAgent({ taskId, agentId: "agt_archived", workspaceId: "ws-1" });

    await pruneGhostAgentLinks({
      taskService: service,
      agentStorage: {
        list: async () => [storedAgent("agt_archived", "2026-08-10T00:00:00.000Z")],
      },
      logger,
      attachedBefore: FUTURE_CUTOFF,
    });

    expect(await service.listTaskAgents(taskId)).toEqual([]);
  });

  it("keeps the link of an agent that is still there", async () => {
    const { taskId } = await seedTask();
    await service.attachAgent({ taskId, agentId: "agt_live", workspaceId: "ws-1" });

    const pruned = await pruneGhostAgentLinks({
      taskService: service,
      agentStorage: { list: async () => [storedAgent("agt_live")] },
      logger,
      attachedBefore: FUTURE_CUTOFF,
    });

    expect(pruned).toEqual([]);
    expect((await service.listTaskAgents(taskId)).map((link) => link.agentId)).toEqual([
      "agt_live",
    ]);
  });

  /** A ghost reviewer is the same lie as a ghost worker: the card offers a chat
   * nobody can open. */
  it("removes reviewer links too", async () => {
    const { taskId } = await seedTask();
    await service.updateTask({ taskId, status: "in_review" });
    await service.attachAgent({
      taskId,
      agentId: "agt_reviewer",
      workspaceId: "ws-1",
      role: "reviewer",
    });

    await pruneGhostAgentLinks({
      taskService: service,
      agentStorage: { list: async () => [] },
      logger,
      attachedBefore: FUTURE_CUTOFF,
    });

    expect(await service.listTaskAgents(taskId)).toEqual([]);
  });

  /** Pruning is repair, not a decision. A feed entry per ghost would fill the
   * board's history with noise at every boot after a cleanup. */
  it("posts nothing to the feed", async () => {
    const { projectId, taskId } = await seedTask();
    await service.attachAgent({ taskId, agentId: "agt_gone", workspaceId: "ws-1" });
    const before = await service.listBoardFeed({ projectId });

    await pruneGhostAgentLinks({
      taskService: service,
      agentStorage: { list: async () => [] },
      logger,
      attachedBefore: FUTURE_CUTOFF,
    });

    expect(await service.listBoardFeed({ projectId })).toEqual(before);
  });

  /** The sweep's two reads are not one snapshot: a link attached while it runs
   * may precede its agent record landing in storage, and deleting it would
   * prune live work. A ghost predates the sweep by definition. */
  it("leaves links attached after the cutoff alone", async () => {
    const { taskId } = await seedTask();
    await service.attachAgent({ taskId, agentId: "agt_fresh", workspaceId: "ws-1" });

    const pruned = await pruneGhostAgentLinks({
      taskService: service,
      agentStorage: { list: async () => [] },
      logger,
      attachedBefore: "2000-01-01T00:00:00.000Z",
    });

    expect(pruned).toEqual([]);
    expect((await service.listTaskAgents(taskId)).map((link) => link.agentId)).toEqual([
      "agt_fresh",
    ]);
  });
});
