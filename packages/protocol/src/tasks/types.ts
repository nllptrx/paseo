import { z } from "zod";
import { AgentProviderSchema } from "../provider-manifest.js";

/**
 * What you intend, not what is happening. Nothing derives `backlog` or
 * `in_review`, which is why these are stored while a plan's column is not —
 * see docs/tasks.md.
 */
export const TaskStatusSchema = z.enum([
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "done",
  "canceled",
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const TASK_STATUSES: readonly TaskStatus[] = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "done",
  "canceled",
];

export const TaskPrioritySchema = z.enum(["urgent", "high", "medium", "low", "none"]);
export type TaskPriority = z.infer<typeof TaskPrioritySchema>;

export const TASK_PRIORITIES: readonly TaskPriority[] = ["urgent", "high", "medium", "low", "none"];

export const TaskProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Uppercase, unique per host. The `PASEO` of `PASEO-42`. */
  prefix: z.string(),
  color: z.string(),
  /** The Paseo project whose checkout this tracker's work happens in, when there
   * is one. A task can exist before any code does. */
  paseoProjectId: z.string().nullable(),
  createdAt: z.string(),
});
export type TaskProject = z.infer<typeof TaskProjectSchema>;

export const TaskLabelSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  color: z.string(),
});
export type TaskLabel = z.infer<typeof TaskLabelSchema>;

/** An agent working a task. Carries no status: whether it is running is read off
 * the agent, so there is nothing here to fall out of sync. */
export const TaskAgentLinkSchema = z.object({
  agentId: z.string(),
  workspaceId: z.string(),
  presetId: z.string().nullable(),
  attachedAt: z.string(),
});
export type TaskAgentLink = z.infer<typeof TaskAgentLinkSchema>;

export const TaskAttachmentSchema = z.object({
  id: z.string(),
  fileName: z.string(),
  mime: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  isImage: z.boolean(),
  createdAt: z.string(),
});
export type TaskAttachment = z.infer<typeof TaskAttachmentSchema>;

export const TaskCommentSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  kind: z.enum(["user", "agent", "system"]),
  authorName: z.string(),
  /** Set when an agent wrote it, so the comment can link back to the transcript. */
  agentId: z.string().nullable(),
  workspaceId: z.string().nullable(),
  body: z.string(),
  attachments: z.array(TaskAttachmentSchema),
  createdAt: z.string(),
});
export type TaskComment = z.infer<typeof TaskCommentSchema>;

export const TaskSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  /** Sequential within the project, allocated once, never reused. */
  number: z.number().int().positive(),
  title: z.string(),
  description: z.string(),
  status: TaskStatusSchema,
  priority: TaskPrioritySchema,
  dueDate: z.string().nullable(),
  parentTaskId: z.string().nullable(),
  /** Fractional, so inserting between two neighbours rewrites one row. */
  position: z.number(),
  labelIds: z.array(z.string()),
  agents: z.array(TaskAgentLinkSchema),
  attachments: z.array(TaskAttachmentSchema),
  commentCount: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Task = z.infer<typeof TaskSchema>;

export const TaskPresetSchema = z.object({
  id: z.string(),
  name: z.string(),
  provider: AgentProviderSchema,
  model: z.string().nullable(),
  modeId: z.string().nullable(),
  thinkingOptionId: z.string().nullable(),
  /** Prepended to the prompt every time this preset dispatches. */
  instructions: z.string(),
  environmentKind: z.enum(["project_default", "new_worktree"]),
  baseBranch: z.string().nullable(),
  createdAt: z.string(),
});
export type TaskPreset = z.infer<typeof TaskPresetSchema>;

/** Everything a list or board view renders, plus the revision it was read at. */
export const TaskSnapshotSchema = z.object({
  revision: z.number().int().nonnegative(),
  projects: z.array(TaskProjectSchema),
  labels: z.array(TaskLabelSchema),
  tasks: z.array(TaskSchema),
});
export type TaskSnapshot = z.infer<typeof TaskSnapshotSchema>;
