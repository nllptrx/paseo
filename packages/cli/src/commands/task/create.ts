import type { Command } from "commander";
import type { SingleResult } from "../../output/index.js";
import { taskSchema, toTaskRow, type TaskRow } from "./schema.js";
import { connectTaskClient, fetchTaskSnapshot, toTaskCommandError } from "./shared.js";
import type { TaskCommandOptions } from "./shared.js";

export interface TaskCreateOptions extends TaskCommandOptions {
  project?: string;
}

export async function runCreateCommand(
  title: string,
  options: TaskCreateOptions,
  _command: Command,
): Promise<SingleResult<TaskRow>> {
  const { client } = await connectTaskClient(options.host);
  try {
    const snapshot = await fetchTaskSnapshot(client);
    const identifier = options.project?.trim();
    const project = identifier
      ? snapshot.projects.find(
          (candidate) =>
            candidate.id === identifier || candidate.prefix === identifier.toUpperCase(),
        )
      : snapshot.projects[0];
    if (!project) {
      throw new Error(
        identifier
          ? `No tracker project matches ${identifier}`
          : "This host has no tracker project yet — create one from the board's capture sheet",
      );
    }
    const payload = await client.tasksCreate({ projectId: project.id, title });
    if (payload.error || !payload.task) {
      throw new Error(payload.error ?? "The host created no task");
    }
    const projectsById = new Map(snapshot.projects.map((entry) => [entry.id, entry]));
    return {
      type: "single",
      data: toTaskRow(payload.task, projectsById),
      schema: taskSchema,
    };
  } catch (error) {
    throw toTaskCommandError("TASK_CREATE_FAILED", "create task", error);
  } finally {
    await client.close().catch(() => {});
  }
}
