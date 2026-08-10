import { z } from "zod";
import { AgentProviderSchema } from "../provider-manifest.js";
import { TaskWorkflowSchema } from "./workflow.js";

/**
 * What you intend, not what is happening. Nothing derives `backlog` or
 * `in_review`, which is why these are stored while a plan's column is not —
 * see docs/kanban-tasks-spec.md.
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

/**
 * How a board behaves when work finishes. `reviewEnabled` routes a settled task
 * to `in_review` instead of `done`; `reviewOnReject` is where a rejected review
 * sends it back to; `archiveWorkspacesOnDone` tears down the worktrees a
 * workflow created once its last step settles.
 */
export const TaskBoardConfigSchema = z.object({
  reviewEnabled: z.boolean(),
  /** The preset a review runs as. A board that names one gets its work read by
   * a fresh agent that did not write it; a board that names none waits for a
   * human. */
  reviewerPresetId: z.string().nullable().optional(),
  reviewOnReject: z.enum(["in_progress", "todo", "backlog"]),
  /** Correction rounds before an agent rejection has to wait for a human.
   * Optional so a new client can still read projects from an older daemon. */
  maxReviewIterations: z.number().int().positive().max(10).optional(),
  archiveWorkspacesOnDone: z.boolean(),
});
export type TaskBoardConfig = z.infer<typeof TaskBoardConfigSchema>;

/** Per-task exceptions to the board's execution defaults. Missing fields
 * inherit; `null` reviewer means this task waits for a human even when the
 * board has an agent reviewer. */
export const TaskExecutionPolicySchema = z.object({
  review: z.enum(["inherit", "required", "disabled"]).optional(),
  /** Whether this task's subtasks are reviewed, written on the parent. It is a
   * field of its own because `review` decides the parent's own final review:
   * "final review only" is this set to `disabled` while `review` is required. */
  subtaskReview: z.enum(["inherit", "required", "disabled"]).optional(),
  reviewerPresetId: z.string().nullable().optional(),
  reviewOnReject: z.enum(["in_progress", "todo", "backlog"]).optional(),
  maxReviewIterations: z.number().int().positive().max(10).optional(),
  archiveWorkspacesOnDone: z.boolean().optional(),
  /** How ordinary delegation resolves its checkout. Explicit workflow steps
   * continue to carry their own workspace strategy. */
  workspace: z.enum(["inherit", "dedicated", "reuse"]).optional(),
});
export type TaskExecutionPolicy = z.infer<typeof TaskExecutionPolicySchema>;

/**
 * How a task starts itself. `on_unblocked` is what makes a subtask chain run
 * hands-free: the preset dispatches when the task's last open blocker reaches a
 * terminal status, so each phase starts when its predecessor settles.
 */
export const TaskExecutionSpecSchema = z.object({
  presetId: z.string(),
  trigger: z.enum(["manual", "on_unblocked"]),
});
export type TaskExecutionSpec = z.infer<typeof TaskExecutionSpecSchema>;

export interface ResolvedTaskExecutionPolicy {
  reviewEnabled: boolean;
  /** What this task's own subtasks inherit for review, before the board. */
  subtaskReview: "inherit" | "required" | "disabled";
  reviewerPresetId: string | null;
  reviewOnReject: TaskBoardConfig["reviewOnReject"];
  maxReviewIterations: number;
  archiveWorkspacesOnDone: boolean;
  workspace: "inherit" | "dedicated" | "reuse";
}

function resolveReviewEnabled(
  board: TaskBoardConfig | undefined,
  override: TaskExecutionPolicy | undefined,
  parent: TaskExecutionPolicy | undefined,
): boolean {
  if (override?.review === "required") return true;
  if (override?.review === "disabled") return false;
  if (parent?.subtaskReview === "required") return true;
  if (parent?.subtaskReview === "disabled") return false;
  return board?.reviewEnabled ?? false;
}

function resolveReviewerPresetId(
  board: TaskBoardConfig | undefined,
  override: TaskExecutionPolicy | undefined,
  parent: TaskExecutionPolicy | undefined,
): string | null {
  if (override && "reviewerPresetId" in override) {
    return override.reviewerPresetId ?? null;
  }
  if (parent && "reviewerPresetId" in parent) {
    return parent.reviewerPresetId ?? null;
  }
  return board?.reviewerPresetId ?? null;
}

/**
 * One resolver for transitions, dispatch and UI summaries. Keeping inheritance
 * here prevents three surfaces from showing different effective behaviour.
 *
 * Three tiers: this task's override, then the parent aggregate's, then the
 * board. A subtask therefore follows the plan its parent set without every
 * subtask having to repeat it, and a subtask that says otherwise still wins.
 */
export function resolveTaskExecutionPolicy(
  board: TaskBoardConfig | undefined,
  override: TaskExecutionPolicy | undefined,
  parent?: TaskExecutionPolicy | undefined,
): ResolvedTaskExecutionPolicy {
  const tiers = [override, parent];
  return {
    reviewEnabled: resolveReviewEnabled(board, override, parent),
    subtaskReview: override?.subtaskReview ?? "inherit",
    reviewerPresetId: resolveReviewerPresetId(board, override, parent),
    reviewOnReject: firstSet(tiers, "reviewOnReject") ?? board?.reviewOnReject ?? "in_progress",
    maxReviewIterations: firstSet(tiers, "maxReviewIterations") ?? board?.maxReviewIterations ?? 3,
    archiveWorkspacesOnDone:
      firstSet(tiers, "archiveWorkspacesOnDone") ?? board?.archiveWorkspacesOnDone ?? false,
    workspace: firstSet(tiers, "workspace") ?? "inherit",
  };
}

/** The nearest tier that set the field: the task, then its parent aggregate. */
function firstSet<K extends keyof TaskExecutionPolicy>(
  tiers: readonly (TaskExecutionPolicy | undefined)[],
  key: K,
): TaskExecutionPolicy[K] | undefined {
  for (const tier of tiers) {
    const value = tier?.[key];
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

export const TaskProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Uppercase, unique per host. The `PASEO` of `PASEO-42`. */
  prefix: z.string(),
  color: z.string(),
  /** The Paseo project whose checkout this tracker's work happens in, when there
   * is one. A task can exist before any code does. */
  paseoProjectId: z.string().nullable(),
  /** The project is the board, so board behaviour is configured here. Optional
   * on the wire: a project without it reviews nothing and archives nothing. */
  board: TaskBoardConfigSchema.optional(),
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
  /** A reviewer is on the card to judge it, not to have done it. Only workers
   * are barred from reviewing. */
  role: z.enum(["worker", "reviewer"]).optional(),
  /** Which engine turns this agent finishing into task progress. Workflow-owned
   * links wait for the workflow's final step; attachment-owned links settle the
   * task directly. Optional for compatibility with hosts before this marker. */
  completionOwner: z.enum(["attachment", "workflow"]).optional(),
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

/** Durable Git identity for work that can outlive any one agent workspace. */
export const TaskIntegrationSchema = z.object({
  branch: z.string(),
  status: z.enum(["pending", "conflicted", "integrated", "not_applicable"]),
  error: z.string().nullable(),
});
export type TaskIntegration = z.infer<typeof TaskIntegrationSchema>;

export const TaskMessageRecipientSchema = z.object({
  /** Stable Paseo agent identity. This is not a task or provider-subagent key. */
  agentId: z.string(),
  /** Workspace at the time of send, retained for useful historical display. */
  workspaceId: z.string().nullable().optional(),
  /** `delivered` means the daemon accepted the prompt for the agent. Paseo has
   * no agent acknowledgement callback, so this never implies read or acted on. */
  deliveryStatus: z.enum(["pending", "delivered", "failed"]),
});
export type TaskMessageRecipient = z.infer<typeof TaskMessageRecipientSchema>;

/** Typed machine history attached to a human-readable feed entry. `kind` stays
 * open on the wire so an older client can parse event kinds added by a newer
 * daemon; daemon writers use a closed union of known kinds. */
export const TaskBoardEventSchema = z.object({
  kind: z.string(),
  taskId: z.string(),
  parentTaskId: z.string().nullable().optional(),
  agentId: z.string().optional(),
  previousStatus: TaskStatusSchema.optional(),
  status: TaskStatusSchema.optional(),
  verdict: z.enum(["approve", "reject"]).optional(),
  cause: z.string().optional(),
});
export type TaskBoardEvent = z.infer<typeof TaskBoardEventSchema>;

/**
 * One entry in a board's feed. `taskId` is null when the entry belongs to the
 * board rather than to a card — a settle notice, or a note typed at the board.
 */
export const TaskCommentSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  taskId: z.string().nullable(),
  kind: z.enum(["user", "agent", "system"]),
  authorName: z.string(),
  /** Set when an agent wrote it, so the comment can link back to the transcript. */
  agentId: z.string().nullable(),
  workspaceId: z.string().nullable(),
  body: z.string(),
  attachments: z.array(TaskAttachmentSchema),
  createdAt: z.string(),
  /** Added after the original comment model. Missing rows are interpreted from
   * `kind` by presentation code for compatibility with older daemons. */
  entryKind: z.enum(["note", "agent_update", "system_event", "message"]).optional(),
  /** Present only for outbound messages. Kept optional so old clients continue
   * to parse feed entries from a new daemon. */
  recipients: z.array(TaskMessageRecipientSchema).optional(),
  /** Present on daemon-authored board events. Optional so feed entries from old
   * daemons and old stored rows keep the original shape. */
  event: TaskBoardEventSchema.optional(),
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
  /** Number of rejected review rounds in the current task lifecycle. */
  reviewIteration: z.number().int().nonnegative().optional(),
  /** Absent means every execution choice inherits from the board/preset. */
  executionPolicy: TaskExecutionPolicySchema.optional(),
  /** How this task starts itself, when it was given a way to. Optional for
   * clients connected to a host from before per-task execution specs. */
  executionSpec: TaskExecutionSpecSchema.optional(),
  /** Optional for clients connected to a host from before task branches. */
  integration: TaskIntegrationSchema.optional(),
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
  /** Provider feature overrides, such as Codex fast mode. Optional so a new
   * client can still read presets from a host that predates feature presets. */
  featureValues: z.record(z.string(), z.unknown()).optional(),
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
  /** Only for tasks that have one; a board is mostly cards without workflows. */
  workflows: z.array(TaskWorkflowSchema).optional(),
  /** `taskId` waits on `dependsOnTaskId`. Optional on the wire: a snapshot
   * without it has no dependencies to draw. */
  dependencies: z.array(z.object({ taskId: z.string(), dependsOnTaskId: z.string() })).optional(),
});
export type TaskSnapshot = z.infer<typeof TaskSnapshotSchema>;
