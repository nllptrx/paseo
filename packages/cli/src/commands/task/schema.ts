import type { Task, TaskProject } from "@getpaseo/protocol/tasks/types";
import type { OutputSchema } from "../../output/index.js";

export interface TaskRow {
  key: string;
  title: string;
  status: string;
  priority: string;
  project: string;
  id: string;
}

export const taskSchema: OutputSchema<TaskRow> = {
  idField: "key",
  columns: [
    { header: "KEY", field: "key", width: 10 },
    { header: "STATUS", field: "status", width: 12 },
    { header: "PRI", field: "priority", width: 8 },
    { header: "TITLE", field: "title", width: 48 },
  ],
};

export function toTaskRow(task: Task, projectsById: Map<string, TaskProject>): TaskRow {
  const project = projectsById.get(task.projectId);
  return {
    key: `${project?.prefix ?? "?"}-${task.number}`,
    title: task.title,
    status: task.status,
    priority: task.priority,
    project: project?.name ?? task.projectId,
    id: task.id,
  };
}
