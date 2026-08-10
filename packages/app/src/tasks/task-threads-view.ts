import type { Task, TaskProject, TaskStatus } from "@getpaseo/protocol/tasks/types";
import { formatTaskKey } from "./task-views";
import {
  compareUpdatedAtDescending,
  type TaskExecutionEntry,
  type TaskExecutionSummary,
} from "./task-execution";

export type TaskThreadTaskSource = Pick<Task, "id" | "projectId" | "number" | "title" | "status">;

export interface TaskThreadGroup {
  /** Stable list key; the untracked group has no task to name it. */
  id: string;
  taskId: string | null;
  /** `PSE-42` for a task group, absent for the untracked one. */
  taskKey: string | null;
  title: string;
  status: TaskStatus | null;
  /** The freshest row in the group, which is what orders the groups. */
  latestUpdateAtMs: number | null;
  rows: TaskExecutionEntry[];
}

export const UNTRACKED_TASK_THREAD_GROUP_ID = "untracked";

function latestUpdate(rows: readonly TaskExecutionEntry[]): number | null {
  let latest: number | null = null;
  for (const row of rows) {
    if (row.updatedAtMs !== null && (latest === null || row.updatedAtMs > latest)) {
      latest = row.updatedAtMs;
    }
  }
  return latest;
}

/**
 * Every thread in the project as one list: the agents attached to each task,
 * then the standalone chats nobody has claimed. The board answers where work
 * sits; this answers what is running right now, off the same execution model
 * the cards read.
 */
export function buildTaskThreadGroups(input: {
  tasks: readonly TaskThreadTaskSource[];
  projectsById: ReadonlyMap<string, Pick<TaskProject, "prefix">>;
  executionByTaskId: ReadonlyMap<string, TaskExecutionSummary>;
  untracked: readonly TaskExecutionEntry[];
  untrackedTitle: string;
}): TaskThreadGroup[] {
  const groups: TaskThreadGroup[] = [];
  for (const task of input.tasks) {
    const rows = [...(input.executionByTaskId.get(task.id)?.entries ?? [])].sort(
      compareUpdatedAtDescending,
    );
    if (rows.length === 0) continue;
    groups.push({
      id: task.id,
      taskId: task.id,
      taskKey: formatTaskKey(input.projectsById.get(task.projectId), task),
      title: task.title,
      status: task.status,
      latestUpdateAtMs: latestUpdate(rows),
      rows,
    });
  }
  groups.sort((left, right) => compareLatestUpdateDescending(left, right));

  const untrackedRows = [...input.untracked].sort(compareUpdatedAtDescending);
  if (untrackedRows.length > 0) {
    // Last, always: unclaimed chats are the leftovers of the list, and letting
    // them float to the top on recency would bury the tracked work.
    groups.push({
      id: UNTRACKED_TASK_THREAD_GROUP_ID,
      taskId: null,
      taskKey: null,
      title: input.untrackedTitle,
      status: null,
      latestUpdateAtMs: latestUpdate(untrackedRows),
      rows: untrackedRows,
    });
  }
  return groups;
}

function compareLatestUpdateDescending(
  left: Pick<TaskThreadGroup, "latestUpdateAtMs">,
  right: Pick<TaskThreadGroup, "latestUpdateAtMs">,
): number {
  if (left.latestUpdateAtMs === right.latestUpdateAtMs) return 0;
  if (left.latestUpdateAtMs === null) return 1;
  if (right.latestUpdateAtMs === null) return -1;
  return right.latestUpdateAtMs - left.latestUpdateAtMs;
}

export function countTaskThreads(groups: readonly TaskThreadGroup[]): number {
  return groups.reduce((total, group) => total + group.rows.length, 0);
}
