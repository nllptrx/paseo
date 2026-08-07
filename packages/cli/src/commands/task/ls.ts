import type { Command } from "commander";
import { TASK_STATUSES, type TaskStatus } from "@getpaseo/protocol/tasks/types";
import type { ListResult } from "../../output/index.js";
import { taskSchema, toTaskRow, type TaskRow } from "./schema.js";
import { connectTaskClient, fetchTaskSnapshot, toTaskCommandError } from "./shared.js";
import type { TaskCommandOptions } from "./shared.js";

export interface TaskLsOptions extends TaskCommandOptions {
  status?: string;
  project?: string;
}

export async function runLsCommand(
  options: TaskLsOptions,
  _command: Command,
): Promise<ListResult<TaskRow>> {
  const { client } = await connectTaskClient(options.host);
  try {
    const snapshot = await fetchTaskSnapshot(client);
    const projectsById = new Map(snapshot.projects.map((project) => [project.id, project]));
    const statusFilter = options.status?.trim();
    if (statusFilter && !TASK_STATUSES.includes(statusFilter as TaskStatus)) {
      throw new Error(`Unknown status: ${statusFilter} (one of ${TASK_STATUSES.join(", ")})`);
    }
    const projectFilter = options.project?.trim().toUpperCase();
    const tasks = snapshot.tasks.filter((task) => {
      if (statusFilter && task.status !== statusFilter) {
        return false;
      }
      if (projectFilter) {
        const project = projectsById.get(task.projectId);
        return project?.prefix === projectFilter || task.projectId === options.project?.trim();
      }
      return true;
    });
    return {
      type: "list",
      data: tasks.map((task) => toTaskRow(task, projectsById)),
      schema: taskSchema,
    };
  } catch (error) {
    throw toTaskCommandError("TASK_LIST_FAILED", "list tasks", error);
  } finally {
    await client.close().catch(() => {});
  }
}
