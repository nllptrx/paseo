import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Step } from "@getpaseo/protocol/tasks/workflow";
import { getTaskContext, TASK_CONTEXT_FEED_LIMIT } from "./task-context.js";
import { TaskService } from "./service.js";

const logger = pino({ level: "silent" });

describe("getTaskContext", () => {
  let directory: string;
  let service: TaskService;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "paseo-task-context-"));
    service = new TaskService({ databasePath: join(directory, "tasks.db"), logger });
  });

  afterEach(async () => {
    await service.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("assembles the caller's live task position from typed board state", async () => {
    const project = await service.createProject({
      name: "Paseo",
      prefix: "PSE",
      color: "#fff",
    });
    await service.configureBoard({ projectId: project.id, reviewEnabled: true });
    const parent = await service.createTask({ projectId: project.id, title: "Parent" });
    const task = await service.createTask({
      projectId: project.id,
      title: "Implement",
      parentTaskId: parent.id,
    });
    const sibling = await service.createTask({
      projectId: project.id,
      title: "Sibling",
      parentTaskId: parent.id,
    });
    const blocker = await service.createTask({ projectId: project.id, title: "Blocker" });
    const dependent = await service.createTask({ projectId: project.id, title: "Dependent" });
    await service.addDependency({ taskId: dependent.id, dependsOnTaskId: task.id });
    await service.attachAgent({
      taskId: task.id,
      agentId: "agt_worker",
      workspaceId: "ws_1",
      completionOwner: "workflow",
    });
    await service.addDependency({ taskId: task.id, dependsOnTaskId: blocker.id });
    const step: Step = {
      id: "stp_1",
      name: "Code",
      prompt: "Implement it",
      agents: [{ provider: "claude" }],
      completion: "all",
      workspace: { mode: "existing", workspaceId: "ws_1" },
      trigger: { type: "manual" },
      runs: [
        {
          id: "run_1",
          startedAt: "2026-01-01T00:00:00.000Z",
          endedAt: null,
          status: "running",
          agentIds: ["agt_worker"],
          workspaceIds: ["ws_1"],
          scheduleId: null,
          error: null,
        },
      ],
    };
    await service.setWorkflow({ taskId: task.id, steps: [step] });
    for (let index = 0; index < TASK_CONTEXT_FEED_LIMIT + 5; index += 1) {
      await service.emitBoardEvent({
        kind: "task_moved",
        taskId: task.id,
        cause: `event ${index}`,
      });
    }

    const context = await getTaskContext({
      source: service,
      taskId: task.id,
      callerAgentId: "agt_worker",
    });

    expect(context.task.id).toBe(task.id);
    expect(context.caller).toMatchObject({ agentId: "agt_worker", role: "worker" });
    expect(context.workflow).toMatchObject({ stepIndex: 0, stepCount: 1, run: { id: "run_1" } });
    expect(context.parents.map((entry) => entry.id)).toEqual([parent.id]);
    expect(context.siblings.map((entry) => entry.id)).toEqual([sibling.id]);
    expect(context.blockers.map((entry) => entry.id)).toEqual([blocker.id]);
    expect(context.dependents.map((entry) => entry.id)).toEqual([sibling.id, dependent.id]);
    expect(context.executionPolicy.reviewEnabled).toBe(true);
    expect(context.feedTail).toHaveLength(TASK_CONTEXT_FEED_LIMIT);
    expect(context.feedTail.every((entry) => entry.event?.kind === "task_moved")).toBe(true);
  });
});
