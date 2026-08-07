import { z } from "zod";
import {
  TaskCommentSchema,
  TaskPrioritySchema,
  TaskProjectSchema,
  TaskSchema,
  TaskSnapshotSchema,
  TaskStatusSchema,
} from "./types.js";

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
});

export const TasksReviewResponseSchema = z.object({
  type: z.literal("tasks.review.response"),
  payload: z.object({
    requestId: z.string(),
    task: TaskSchema.nullable(),
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
