import { z } from "zod";
import {
  TaskCommentSchema,
  TaskExecutionPolicySchema,
  TaskExecutionSpecSchema,
  TaskPrioritySchema,
  TaskPresetSchema,
  TaskProjectSchema,
  TaskSchema,
  TaskSnapshotSchema,
  TaskStatusSchema,
} from "./types.js";
import { StepInputSchema, StepSchema, TaskWorkflowSchema } from "./workflow.js";

export const TasksSnapshotRequestSchema = z.object({
  type: z.literal("tasks.snapshot.request"),
  requestId: z.string(),
});

export const TasksSnapshotResponseSchema = z.object({
  type: z.literal("tasks.snapshot.response"),
  payload: z.object({
    requestId: z.string(),
    snapshot: TaskSnapshotSchema.nullable(),
    error: z.string().nullable(),
  }),
});

export const TasksProjectCreateRequestSchema = z.object({
  type: z.literal("tasks.project.create.request"),
  requestId: z.string(),
  name: z.string().trim().min(1),
  prefix: z.string().trim().min(1).max(8),
  color: z.string().trim().min(1),
  paseoProjectId: z.string().nullable().optional(),
});

export const TasksProjectCreateResponseSchema = z.object({
  type: z.literal("tasks.project.create.response"),
  payload: z.object({
    requestId: z.string(),
    project: TaskProjectSchema.nullable(),
    error: z.string().nullable(),
  }),
});

export const TasksLabelCreateRequestSchema = z.object({
  type: z.literal("tasks.label.create.request"),
  requestId: z.string(),
  projectId: z.string(),
  name: z.string().trim().min(1),
  color: z.string().trim().min(1),
});

export const TasksLabelCreateResponseSchema = z.object({
  type: z.literal("tasks.label.create.response"),
  payload: z.object({
    requestId: z.string(),
    labelId: z.string().nullable(),
    error: z.string().nullable(),
  }),
});

export const TasksLabelDeleteRequestSchema = z.object({
  type: z.literal("tasks.label.delete.request"),
  requestId: z.string(),
  labelId: z.string(),
});

export const TasksLabelDeleteResponseSchema = z.object({
  type: z.literal("tasks.label.delete.response"),
  payload: z.object({
    requestId: z.string(),
    labelId: z.string(),
    error: z.string().nullable(),
  }),
});

export const TasksCreateRequestSchema = z.object({
  type: z.literal("tasks.create.request"),
  requestId: z.string(),
  projectId: z.string(),
  title: z.string().trim().min(1),
  description: z.string().optional(),
  status: TaskStatusSchema.optional(),
  priority: TaskPrioritySchema.optional(),
  dueDate: z.string().nullable().optional(),
  parentTaskId: z.string().nullable().optional(),
  labelIds: z.array(z.string()).optional(),
  executionPolicy: TaskExecutionPolicySchema.optional(),
  executionSpec: TaskExecutionSpecSchema.optional(),
  /** Subtasks chain sequentially by default; this one is ready with its
   * predecessor instead. Ignored without a `parentTaskId`. */
  parallel: z.boolean().optional(),
});

export const TasksCreateResponseSchema = z.object({
  type: z.literal("tasks.create.response"),
  payload: z.object({
    requestId: z.string(),
    task: TaskSchema.nullable(),
    error: z.string().nullable(),
  }),
});

export const TasksUpdateRequestSchema = z.object({
  type: z.literal("tasks.update.request"),
  requestId: z.string(),
  taskId: z.string(),
  title: z.string().trim().min(1).optional(),
  description: z.string().optional(),
  status: TaskStatusSchema.optional(),
  priority: TaskPrioritySchema.optional(),
  dueDate: z.string().nullable().optional(),
  parentTaskId: z.string().nullable().optional(),
  labelIds: z.array(z.string()).optional(),
  /** Null clears all task-level exceptions back to board defaults. */
  executionPolicy: TaskExecutionPolicySchema.nullable().optional(),
  /** Null stops the task starting itself. */
  executionSpec: TaskExecutionSpecSchema.nullable().optional(),
});

export const TasksUpdateResponseSchema = z.object({
  type: z.literal("tasks.update.response"),
  payload: z.object({
    requestId: z.string(),
    task: TaskSchema.nullable(),
    error: z.string().nullable(),
  }),
});

/** A drop. The client sends the neighbours it landed between; the daemon picks
 * the position, so two clients dropping at once cannot pick the same one. */
export const TasksMoveRequestSchema = z.object({
  type: z.literal("tasks.move.request"),
  requestId: z.string(),
  taskId: z.string(),
  status: TaskStatusSchema,
  beforePosition: z.number().nullable(),
  afterPosition: z.number().nullable(),
});

export const TasksMoveResponseSchema = z.object({
  type: z.literal("tasks.move.response"),
  payload: z.object({
    requestId: z.string(),
    task: TaskSchema.nullable(),
    error: z.string().nullable(),
  }),
});

export const TasksDeleteRequestSchema = z.object({
  type: z.literal("tasks.delete.request"),
  requestId: z.string(),
  taskId: z.string(),
});

export const TasksDeleteResponseSchema = z.object({
  type: z.literal("tasks.delete.response"),
  payload: z.object({
    requestId: z.string(),
    taskId: z.string(),
    error: z.string().nullable(),
  }),
});

export const TasksAgentAttachRequestSchema = z.object({
  type: z.literal("tasks.agent.attach.request"),
  requestId: z.string(),
  taskId: z.string(),
  agentId: z.string(),
  workspaceId: z.string(),
  presetId: z.string().nullable().optional(),
});

export const TasksAgentAttachResponseSchema = z.object({
  type: z.literal("tasks.agent.attach.response"),
  payload: z.object({
    requestId: z.string(),
    task: TaskSchema.nullable(),
    error: z.string().nullable(),
  }),
});

export const TasksAgentDetachRequestSchema = z.object({
  type: z.literal("tasks.agent.detach.request"),
  requestId: z.string(),
  taskId: z.string(),
  agentId: z.string(),
});

export const TasksAgentDetachResponseSchema = z.object({
  type: z.literal("tasks.agent.detach.response"),
  payload: z.object({
    requestId: z.string(),
    task: TaskSchema.nullable(),
    error: z.string().nullable(),
  }),
});

export const TasksCommentCreateRequestSchema = z.object({
  type: z.literal("tasks.comment.create.request"),
  requestId: z.string(),
  taskId: z.string(),
  body: z.string().trim().min(1),
});

export const TasksCommentCreateResponseSchema = z.object({
  type: z.literal("tasks.comment.create.response"),
  payload: z.object({
    requestId: z.string(),
    comment: TaskCommentSchema.nullable(),
    error: z.string().nullable(),
  }),
});

/** A review verdict. Approve sends the task to done; reject sends it back to
 * the board's `review.onReject` (default in_progress). */
export const TasksReviewRequestSchema = z.object({
  type: z.literal("tasks.review.request"),
  requestId: z.string(),
  taskId: z.string(),
  verdict: z.enum(["approve", "reject"]),
  /** Reviewer findings. New clients send this with reject; older clients can
   * continue sending a verdict alone. */
  feedback: z.string().trim().min(1).optional(),
});

export const TasksReviewResponseSchema = z.object({
  type: z.literal("tasks.review.response"),
  payload: z.object({
    requestId: z.string(),
    task: TaskSchema.nullable(),
    error: z.string().nullable(),
  }),
});

/** Puts a reviewer on a card that is in review without one running — the same
 * arming a manual move into review performs. */
export const TasksReviewStartRequestSchema = z.object({
  type: z.literal("tasks.review.start.request"),
  requestId: z.string(),
  taskId: z.string(),
});

export const TasksReviewStartResponseSchema = z.object({
  type: z.literal("tasks.review.start.response"),
  payload: z.object({
    requestId: z.string(),
    taskId: z.string(),
    error: z.string().nullable(),
  }),
});

export const TasksSubscribeRequestSchema = z.object({
  type: z.literal("tasks.subscribe.request"),
  requestId: z.string(),
});

export const TasksSubscribeResponseSchema = z.object({
  type: z.literal("tasks.subscribe.response"),
  payload: z.object({
    requestId: z.string(),
    error: z.string().nullable(),
  }),
});

export const TasksUnsubscribeRequestSchema = z.object({
  type: z.literal("tasks.unsubscribe.request"),
  requestId: z.string(),
});

export const TasksUnsubscribeResponseSchema = z.object({
  type: z.literal("tasks.unsubscribe.response"),
  payload: z.object({
    requestId: z.string(),
    error: z.string().nullable(),
  }),
});

/** Carries the revision rather than a diff: a client that is already at this
 * revision has nothing to do, and one that is behind refetches the snapshot. */
export const TasksUpdatePushSchema = z.object({
  type: z.literal("tasks.update"),
  payload: z.object({
    revision: z.number().int().nonnegative(),
  }),
});

export const TasksBoardConfigureRequestSchema = z.object({
  type: z.literal("tasks.board.configure.request"),
  requestId: z.string(),
  projectId: z.string(),
  reviewEnabled: z.boolean().optional(),
  reviewOnReject: z.enum(["in_progress", "todo", "backlog"]).optional(),
  maxReviewIterations: z.number().int().positive().max(10).optional(),
  archiveWorkspacesOnDone: z.boolean().optional(),
  reviewerPresetId: z.string().nullable().optional(),
});

export const TasksBoardConfigureResponseSchema = z.object({
  type: z.literal("tasks.board.configure.response"),
  payload: z.object({
    requestId: z.string(),
    project: TaskProjectSchema.nullable(),
    error: z.string().nullable(),
  }),
});

export const TasksWorkflowSetRequestSchema = z.object({
  type: z.literal("tasks.workflow.set.request"),
  requestId: z.string(),
  taskId: z.string(),
  steps: z.array(StepInputSchema).min(1),
});

export const TasksWorkflowSetResponseSchema = z.object({
  type: z.literal("tasks.workflow.set.response"),
  payload: z.object({
    requestId: z.string(),
    workflow: TaskWorkflowSchema.nullable(),
    error: z.string().nullable(),
  }),
});

export const TasksWorkflowClearRequestSchema = z.object({
  type: z.literal("tasks.workflow.clear.request"),
  requestId: z.string(),
  taskId: z.string(),
});

export const TasksWorkflowClearResponseSchema = z.object({
  type: z.literal("tasks.workflow.clear.response"),
  payload: z.object({
    requestId: z.string(),
    error: z.string().nullable(),
  }),
});

const TaskStepTargetSchema = z.object({
  requestId: z.string(),
  taskId: z.string(),
  stepId: z.string(),
});

const TaskStepResultSchema = z.object({
  requestId: z.string(),
  step: StepSchema.nullable(),
  error: z.string().nullable(),
});

export const TasksStepRunRequestSchema = TaskStepTargetSchema.extend({
  type: z.literal("tasks.step.run.request"),
});

export const TasksStepRunResponseSchema = z.object({
  type: z.literal("tasks.step.run.response"),
  payload: TaskStepResultSchema,
});

export const TasksStepRetryRequestSchema = TaskStepTargetSchema.extend({
  type: z.literal("tasks.step.retry.request"),
});

export const TasksStepRetryResponseSchema = z.object({
  type: z.literal("tasks.step.retry.response"),
  payload: TaskStepResultSchema,
});

export const TasksStepSkipRequestSchema = TaskStepTargetSchema.extend({
  type: z.literal("tasks.step.skip.request"),
});

export const TasksStepSkipResponseSchema = z.object({
  type: z.literal("tasks.step.skip.response"),
  payload: TaskStepResultSchema,
});

export const TasksStepCancelRequestSchema = TaskStepTargetSchema.extend({
  type: z.literal("tasks.step.cancel.request"),
});

export const TasksStepCancelResponseSchema = z.object({
  type: z.literal("tasks.step.cancel.response"),
  payload: TaskStepResultSchema,
});

export const TasksFeedReadRequestSchema = z.object({
  type: z.literal("tasks.feed.read.request"),
  requestId: z.string(),
  projectId: z.string(),
  limit: z.number().int().positive().max(500).optional(),
});

export const TasksFeedReadResponseSchema = z.object({
  type: z.literal("tasks.feed.read.response"),
  payload: z.object({
    requestId: z.string(),
    entries: z.array(TaskCommentSchema),
    error: z.string().nullable(),
  }),
});

/** A note typed at the board rather than on a card. `taskId` carries one when
 * the composer was opened from a card. */
export const TasksFeedPostRequestSchema = z.object({
  type: z.literal("tasks.feed.post.request"),
  requestId: z.string(),
  projectId: z.string(),
  taskId: z.string().nullable().optional(),
  body: z.string().trim().min(1),
  /** Also deliver this to the agents working the named card. A note is history
   * by default; sending it is a separate thing to have asked for. */
  notifyTaskAgents: z.boolean().optional(),
  /** New clients mark notes explicitly so `@` remains plain history. Missing
   * preserves the released mention/notify behavior for old clients. */
  entryKind: z.literal("note").optional(),
});

export const TasksFeedPostResponseSchema = z.object({
  type: z.literal("tasks.feed.post.response"),
  payload: z.object({
    requestId: z.string(),
    entry: TaskCommentSchema.nullable(),
    error: z.string().nullable(),
  }),
});

export const TasksFeedSendMessageRequestSchema = z.object({
  type: z.literal("tasks.feed.send_message.request"),
  requestId: z.string(),
  projectId: z.string(),
  taskId: z.string(),
  body: z.string().trim().min(1),
  recipientAgentIds: z.array(z.string().trim().min(1)).min(1).max(10),
});

export const TasksFeedSendMessageResponseSchema = z.object({
  type: z.literal("tasks.feed.send_message.response"),
  payload: z.object({
    requestId: z.string(),
    entry: TaskCommentSchema.nullable(),
    error: z.string().nullable(),
  }),
});

export const TasksDependencyAddRequestSchema = z.object({
  type: z.literal("tasks.dependency.add.request"),
  requestId: z.string(),
  taskId: z.string(),
  dependsOnTaskId: z.string(),
});

export const TasksDependencyRemoveRequestSchema = z.object({
  type: z.literal("tasks.dependency.remove.request"),
  requestId: z.string(),
  taskId: z.string(),
  dependsOnTaskId: z.string(),
});

const TaskDependencyResultSchema = z.object({
  requestId: z.string(),
  error: z.string().nullable(),
});

export const TasksDependencyAddResponseSchema = z.object({
  type: z.literal("tasks.dependency.add.response"),
  payload: TaskDependencyResultSchema,
});

export const TasksDependencyRemoveResponseSchema = z.object({
  type: z.literal("tasks.dependency.remove.response"),
  payload: TaskDependencyResultSchema,
});

export const TasksPresetListRequestSchema = z.object({
  type: z.literal("tasks.preset.list.request"),
  requestId: z.string(),
});

export const TasksPresetListResponseSchema = z.object({
  type: z.literal("tasks.preset.list.response"),
  payload: z.object({
    requestId: z.string(),
    presets: z.array(TaskPresetSchema),
    error: z.string().nullable(),
  }),
});

/** Either a saved preset or a one-off description of how to run this once. */
export const TasksDelegateRequestSchema = z.object({
  type: z.literal("tasks.delegate.request"),
  requestId: z.string(),
  taskId: z.string(),
  presetId: z.string().optional(),
  agent: z
    .object({
      provider: z.string().trim().min(1),
      model: z.string().trim().min(1).nullable().optional(),
      modeId: z.string().trim().min(1).nullable().optional(),
      thinkingOptionId: z.string().trim().min(1).nullable().optional(),
      featureValues: z.record(z.string(), z.unknown()).optional(),
      instructions: z.string().optional(),
      environmentKind: z.enum(["project_default", "new_worktree"]).optional(),
    })
    .optional(),
});

export const TasksDelegateResponseSchema = z.object({
  type: z.literal("tasks.delegate.response"),
  payload: z.object({
    requestId: z.string(),
    agentId: z.string().nullable(),
    error: z.string().nullable(),
  }),
});

export const TasksPresetCreateRequestSchema = z.object({
  type: z.literal("tasks.preset.create.request"),
  requestId: z.string(),
  name: z.string().trim().min(1),
  provider: z.string().trim().min(1),
  model: z.string().trim().min(1).nullable().optional(),
  modeId: z.string().trim().min(1).nullable().optional(),
  thinkingOptionId: z.string().trim().min(1).nullable().optional(),
  featureValues: z.record(z.string(), z.unknown()).optional(),
  instructions: z.string().optional(),
  environmentKind: z.enum(["project_default", "new_worktree"]),
  baseBranch: z.string().trim().min(1).nullable().optional(),
});

export const TasksPresetCreateResponseSchema = z.object({
  type: z.literal("tasks.preset.create.response"),
  payload: z.object({
    requestId: z.string(),
    preset: TaskPresetSchema.nullable(),
    error: z.string().nullable(),
  }),
});

export const TasksPresetDeleteRequestSchema = z.object({
  type: z.literal("tasks.preset.delete.request"),
  requestId: z.string(),
  presetId: z.string(),
});

export const TasksPresetDeleteResponseSchema = z.object({
  type: z.literal("tasks.preset.delete.response"),
  payload: z.object({
    requestId: z.string(),
    error: z.string().nullable(),
  }),
});
