import type { SQLInputValue, StatementSync } from "node:sqlite";
import { z } from "zod";
import { TaskPrioritySchema, TaskStatusSchema } from "@getpaseo/protocol/tasks/types";

/**
 * SQLite hands back `Record<string, SQLOutputValue>` — the driver knows nothing
 * about the columns it just selected. These schemas are the boundary where an
 * untyped row becomes a value, the same way every other store in the daemon
 * turns `JSON.parse` output into one.
 *
 * They earn their keep on the day the file on disk is older than the binary
 * reading it: a missing column fails here, naming the table, instead of becoming
 * an `undefined` that travels.
 */

/** SQLite has no boolean; the column is constrained to 0 or 1. */
const BooleanColumn = z.union([z.literal(0), z.literal(1)]);

export const TaskProjectRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  prefix: z.string(),
  next_task_number: z.number(),
  color: z.string(),
  paseo_project_id: z.string().nullable(),
  reviewer_preset_id: z.string().nullable(),
  max_review_iterations: z.number().int().positive(),
  review_enabled: BooleanColumn,
  review_on_reject: z.enum(["in_progress", "todo", "backlog"]),
  archive_workspaces_on_done: BooleanColumn,
  created_at: z.string(),
});
export type TaskProjectRow = z.infer<typeof TaskProjectRowSchema>;

export const TaskWorkflowRowSchema = z.object({
  task_id: z.string(),
  steps: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type TaskWorkflowRow = z.infer<typeof TaskWorkflowRowSchema>;

export const TaskDependencyRowSchema = z.object({
  task_id: z.string(),
  depends_on_task_id: z.string(),
});
export type TaskDependencyRow = z.infer<typeof TaskDependencyRowSchema>;

export const TaskRowSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  number: z.number(),
  title: z.string(),
  description: z.string(),
  status: TaskStatusSchema,
  priority: TaskPrioritySchema,
  due_date: z.string().nullable(),
  parent_task_id: z.string().nullable(),
  position: z.number(),
  created_at: z.string(),
  updated_at: z.string(),
  review_iteration: z.number().int().nonnegative(),
  execution_policy: z.string().nullable(),
  execution_spec: z.string().nullable(),
  integration_branch: z.string().nullable(),
  integration_status: z.enum(["pending", "conflicted", "integrated", "not_applicable"]).nullable(),
  integration_error: z.string().nullable(),
});
export type TaskRow = z.infer<typeof TaskRowSchema>;

export const TaskLabelRowSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  name: z.string(),
  color: z.string(),
});
export type TaskLabelRow = z.infer<typeof TaskLabelRowSchema>;

export const TaskCommentRowSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  task_id: z.string().nullable(),
  kind: z.enum(["user", "agent", "system"]),
  author_name: z.string(),
  agent_id: z.string().nullable(),
  workspace_id: z.string().nullable(),
  body: z.string(),
  entry_kind: z.enum(["note", "agent_update", "system_event", "message"]).nullable(),
  recipients_json: z.string().nullable(),
  event_json: z.string().nullable(),
  created_at: z.string(),
});
export type TaskCommentRow = z.infer<typeof TaskCommentRowSchema>;

export const TaskAttachmentRowSchema = z.object({
  id: z.string(),
  task_id: z.string().nullable(),
  comment_id: z.string().nullable(),
  file_name: z.string(),
  mime: z.string(),
  size_bytes: z.number(),
  blob_path: z.string(),
  is_image: BooleanColumn,
  created_at: z.string(),
});
export type TaskAttachmentRow = z.infer<typeof TaskAttachmentRowSchema>;

export const TaskAgentRowSchema = z.object({
  task_id: z.string(),
  agent_id: z.string(),
  workspace_id: z.string(),
  preset_id: z.string().nullable(),
  role: z.enum(["worker", "reviewer"]),
  completion_owner: z.enum(["attachment", "workflow"]),
  attached_at: z.string(),
});
export type TaskAgentRow = z.infer<typeof TaskAgentRowSchema>;

export const TaskPresetRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  provider: z.string(),
  model: z.string().nullable(),
  mode_id: z.string().nullable(),
  thinking_option_id: z.string().nullable(),
  feature_values: z.string().nullable(),
  instructions: z.string(),
  environment_kind: z.enum(["project_default", "new_worktree"]),
  base_branch: z.string().nullable(),
  created_at: z.string(),
});
export type TaskPresetRow = z.infer<typeof TaskPresetRowSchema>;

export const RevisionRowSchema = z.object({ revision: z.number() });
export const CountRowSchema = z.object({ total: z.number() });
export const MaxPositionRowSchema = z.object({ top: z.number().nullable() });
export const NextNumberRowSchema = z.object({ next_task_number: z.number() });
export const LabelIdRowSchema = z.object({ label_id: z.string() });
export const TaskIdRowSchema = z.object({ task_id: z.string() });
export const BlobPathRowSchema = z.object({ blob_path: z.string() });

export class TaskRowShapeError extends Error {
  constructor(
    readonly table: string,
    readonly detail: string,
  ) {
    super(
      `tasks.db: a row from "${table}" does not match the shape this build expects (${detail}). ` +
        `The database was likely written by a newer or older Paseo; update the app or move tasks.db aside.`,
    );
    this.name = "TaskRowShapeError";
  }
}

function parseRow<T>(schema: z.ZodType<T>, row: unknown, table: string): T {
  const parsed = schema.safeParse(row);
  if (!parsed.success) {
    throw new TaskRowShapeError(
      table,
      parsed.error.issues.map((issue) => issue.path.join(".")).join(", "),
    );
  }
  return parsed.data;
}

export function selectAll<T>(
  statement: StatementSync,
  schema: z.ZodType<T>,
  table: string,
  params: readonly SQLInputValue[] = [],
): T[] {
  return statement.all(...params).map((row) => parseRow(schema, row, table));
}

export function selectOne<T>(
  statement: StatementSync,
  schema: z.ZodType<T>,
  table: string,
  params: readonly SQLInputValue[] = [],
): T | null {
  const row = statement.get(...params);
  return row === undefined ? null : parseRow(schema, row, table);
}
