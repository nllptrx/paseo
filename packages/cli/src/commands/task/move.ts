import type { Command } from "commander";
import { TASK_STATUSES, type TaskStatus } from "@getpaseo/protocol/tasks/types";
import type { SingleResult } from "../../output/index.js";
import { taskSchema, toTaskRow, type TaskRow } from "./schema.js";
import {
  connectTaskClient,
  fetchTaskSnapshot,
  resolveTaskByKeyOrId,
  toTaskCommandError,
} from "./shared.js";
import type { TaskCommandOptions } from "./shared.js";

export async function runMoveCommand(
  identifier: string,
  status: string,
  options: TaskCommandOptions,
  _command: Command,
): Promise<SingleResult<TaskRow>> {
  const { client } = await connectTaskClient(options.host);
  try {
    if (!TASK_STATUSES.includes(status as TaskStatus)) {
      throw new Error(`Unknown status: ${status} (one of ${TASK_STATUSES.join(", ")})`);
    }
    const snapshot = await fetchTaskSnapshot(client);
    const task = resolveTaskByKeyOrId(snapshot, identifier);
    const column = snapshot.tasks
      .filter((candidate) => candidate.status === status && candidate.id !== task.id)
      .sort((left, right) => left.position - right.position);
    const last = column.at(-1);
    const payload = await client.tasksMove({
      taskId: task.id,
      status: status as TaskStatus,
      beforePosition: last?.position ?? null,
      afterPosition: null,
    });
    if (payload.error || !payload.task) {
      throw new Error(payload.error ?? "The host moved no task");
    }
    const projectsById = new Map(snapshot.projects.map((entry) => [entry.id, entry]));
    return {
      type: "single",
      data: toTaskRow(payload.task, projectsById),
      schema: taskSchema,
    };
  } catch (error) {
    throw toTaskCommandError("TASK_MOVE_FAILED", "move task", error);
  } finally {
    await client.close().catch(() => {});
  }
}
