import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildTaskAgentBriefing } from "./agent-briefing.js";
import { TaskService } from "./service.js";

const logger = pino({ level: "silent" });

describe("buildTaskAgentBriefing", () => {
  let directory: string;
  let service: TaskService;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "paseo-agent-briefing-"));
    service = new TaskService({ databasePath: join(directory, "tasks.db"), logger });
  });

  afterEach(async () => {
    await service.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("describes the agent's live position and pull-awareness contract", async () => {
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
    const blocker = await service.createTask({ projectId: project.id, title: "Blocker" });
    const dependent = await service.createTask({ projectId: project.id, title: "Dependent" });
    await service.addDependency({ taskId: task.id, dependsOnTaskId: blocker.id });
    await service.addDependency({ taskId: dependent.id, dependsOnTaskId: task.id });

    const briefing = await buildTaskAgentBriefing({
      taskService: service,
      taskId: task.id,
      role: "workflow_step",
      toolsAvailable: true,
      step: { name: "Code", index: 2, total: 3 },
    });

    expect(briefing).toContain("Paseo task environment");
    expect(briefing).toContain(`Task ID: ${task.id}`);
    expect(briefing).toContain("Role: worker for one workflow step");
    expect(briefing).toContain("Parent chain: PSE-1 (backlog)");
    expect(briefing).toContain("Open blockers: PSE-3 (backlog)");
    expect(briefing).toContain("Dependents: PSE-4 (backlog)");
    expect(briefing).toContain("Workflow position: step 2 of 3 — Code");
    expect(briefing).toContain("get_task_context: refresh your live task position");
    expect(briefing).toContain("awareness is pulled");
  });
});
