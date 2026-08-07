import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { Task, TaskSnapshot } from "@getpaseo/protocol/tasks/types";
import type { CommandError, CommandOptions } from "../../output/index.js";
import { connectToDaemon, getDaemonHost } from "../../utils/client.js";

export interface TaskCommandOptions extends CommandOptions {
  host?: string;
}

export async function connectTaskClient(
  host: string | undefined,
): Promise<{ client: DaemonClient; host: string }> {
  const resolvedHost = getDaemonHost({ host });
  try {
    const client = await connectToDaemon({ host });
    return { client, host: resolvedHost };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw {
      code: "DAEMON_NOT_RUNNING",
      message: `Cannot connect to daemon at ${resolvedHost}: ${message}`,
      details: "Start the daemon with: paseo daemon start",
    } satisfies CommandError;
  }
}

export function toTaskCommandError(code: string, action: string, error: unknown): CommandError {
  const message = error instanceof Error ? error.message : String(error);
  return { code, message: `Failed to ${action}: ${message}` };
}

export async function fetchTaskSnapshot(client: DaemonClient): Promise<TaskSnapshot> {
  const payload = await client.tasksSnapshot();
  if (payload.error || !payload.snapshot) {
    throw new Error(payload.error ?? "This host has no task tracker");
  }
  return payload.snapshot;
}

/** `PSE-42` or a raw task id — a key can be typed, an id can be pasted. */
export function resolveTaskByKeyOrId(snapshot: TaskSnapshot, identifier: string): Task {
  const trimmed = identifier.trim();
  const byId = snapshot.tasks.find((task) => task.id === trimmed);
  if (byId) {
    return byId;
  }
  const match = /^([A-Za-z]+)-(\d+)$/.exec(trimmed);
  if (match) {
    const prefix = match[1].toUpperCase();
    const number = Number.parseInt(match[2], 10);
    const project = snapshot.projects.find((candidate) => candidate.prefix === prefix);
    const task = project
      ? snapshot.tasks.find(
          (candidate) => candidate.projectId === project.id && candidate.number === number,
        )
      : undefined;
    if (task) {
      return task;
    }
  }
  throw new Error(`No task matches ${identifier}`);
}
