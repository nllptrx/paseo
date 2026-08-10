import { z } from "zod";
import {
  resolveTaskExecutionPolicy,
  TaskAgentLinkSchema,
  TaskCommentSchema,
  TaskSchema,
} from "@getpaseo/protocol/tasks/types";
import { StepRunSchema, StepSchema } from "@getpaseo/protocol/tasks/workflow";
import type { TaskService } from "./service.js";

export const TASK_CONTEXT_FEED_LIMIT = 20;

const ResolvedTaskExecutionPolicySchema = z.object({
  reviewEnabled: z.boolean(),
  subtaskReview: z.enum(["inherit", "required", "disabled"]),
  reviewerPresetId: z.string().nullable(),
  reviewOnReject: z.enum(["in_progress", "todo", "backlog"]),
  maxReviewIterations: z.number().int().positive(),
  archiveWorkspacesOnDone: z.boolean(),
  workspace: z.enum(["inherit", "dedicated", "reuse"]),
});

export const TaskContextSchema = z.object({
  task: TaskSchema,
  caller: z.object({
    agentId: z.string().nullable(),
    role: z.enum(["worker", "reviewer"]).nullable(),
    attachment: TaskAgentLinkSchema.nullable(),
  }),
  workflow: z
    .object({
      step: StepSchema,
      stepIndex: z.number().int().nonnegative(),
      stepCount: z.number().int().positive(),
      run: StepRunSchema,
    })
    .nullable(),
  parents: z.array(TaskSchema),
  siblings: z.array(TaskSchema),
  blockers: z.array(TaskSchema),
  dependents: z.array(TaskSchema),
  executionPolicy: ResolvedTaskExecutionPolicySchema,
  feedTail: z.array(TaskCommentSchema),
});
export type TaskContext = z.infer<typeof TaskContextSchema>;

export interface TaskContextSource extends Pick<
  TaskService,
  | "getTask"
  | "getProject"
  | "getWorkflow"
  | "listTaskAgents"
  | "listSubtasks"
  | "listBlockers"
  | "listDependents"
  | "listBoardFeed"
> {}

async function listParents(source: TaskContextSource, parentTaskId: string | null) {
  const parents: TaskContext["parents"] = [];
  let currentId = parentTaskId;
  while (currentId) {
    const parent = await source.getTask(currentId);
    if (!parent) {
      break;
    }
    parents.unshift(parent);
    currentId = parent.parentTaskId;
  }
  return parents;
}

async function listTasks(source: TaskContextSource, taskIds: readonly string[]) {
  const tasks = await Promise.all(taskIds.map((taskId) => source.getTask(taskId)));
  return tasks
    .filter((task): task is NonNullable<typeof task> => task !== null)
    .toSorted((left, right) => left.number - right.number);
}

function findWorkflowPosition(
  workflow: Awaited<ReturnType<TaskContextSource["getWorkflow"]>>,
  callerAgentId: string | null,
): TaskContext["workflow"] {
  if (!workflow || !callerAgentId) {
    return null;
  }
  for (const [stepIndex, step] of workflow.steps.entries()) {
    const run = step.runs
      .toReversed()
      .find((candidate) =>
        candidate.status === "running" ? candidate.agentIds.includes(callerAgentId) : false,
      );
    if (run) {
      return { step, stepIndex, stepCount: workflow.steps.length, run };
    }
  }
  return null;
}

export async function getTaskContext(input: {
  source: TaskContextSource;
  taskId: string;
  callerAgentId: string | null;
}): Promise<TaskContext> {
  const task = await input.source.getTask(input.taskId);
  if (!task) {
    throw new Error(`Task not found: ${input.taskId}`);
  }
  const project = await input.source.getProject(task.projectId);
  if (!project) {
    throw new Error(`Task project not found: ${task.projectId}`);
  }
  const [attachments, workflow, parents, siblings, blockers, dependentIds, feed] =
    await Promise.all([
      input.source.listTaskAgents(task.id),
      input.source.getWorkflow(task.id),
      listParents(input.source, task.parentTaskId),
      task.parentTaskId
        ? input.source
            .listSubtasks(task.parentTaskId)
            .then((tasks) => tasks.filter((sibling) => sibling.id !== task.id))
        : Promise.resolve([]),
      input.source.listBlockers(task.id),
      input.source.listDependents(task.id),
      input.source.listBoardFeed({
        projectId: task.projectId,
        limit: TASK_CONTEXT_FEED_LIMIT,
      }),
    ]);
  const attachment = input.callerAgentId
    ? (attachments.find((candidate) => candidate.agentId === input.callerAgentId) ?? null)
    : null;
  const parent = parents.at(-1) ?? null;
  const executionPolicy = resolveTaskExecutionPolicy(
    project.board,
    task.executionPolicy,
    parent?.executionPolicy,
  );
  return {
    task,
    caller: {
      agentId: input.callerAgentId,
      role: attachment ? (attachment.role ?? "worker") : null,
      attachment,
    },
    workflow: findWorkflowPosition(workflow, input.callerAgentId),
    parents,
    siblings,
    blockers,
    dependents: await listTasks(input.source, dependentIds),
    executionPolicy,
    feedTail: feed.filter((entry) => entry.taskId === task.id),
  };
}
