import { z } from "zod";
import { AgentProviderSchema } from "../provider-manifest.js";
import { ScheduleCadenceSchema } from "../schedule/types.js";

export const StepAgentSpecSchema = z.object({
  provider: AgentProviderSchema,
  model: z.string().trim().min(1).optional(),
  modeId: z.string().trim().min(1).optional(),
  thinkingOptionId: z.string().trim().min(1).optional(),
  featureValues: z.record(z.string(), z.unknown()).optional(),
  promptOverride: z.string().trim().min(1).optional(),
});
export type StepAgentSpec = z.infer<typeof StepAgentSpecSchema>;

export const StepWorkspaceStrategySchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("reuse_previous") }),
  z.object({ mode: z.literal("existing"), workspaceId: z.string().trim().min(1) }),
  z.object({ mode: z.literal("worktree") }),
  z.object({ mode: z.literal("worktree_per_agent") }),
]);
export type StepWorkspaceStrategy = z.infer<typeof StepWorkspaceStrategySchema>;

export const StepTriggerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("immediate") }),
  z.object({ type: z.literal("manual") }),
  z.object({ type: z.literal("schedule"), cadence: ScheduleCadenceSchema }),
]);
export type StepTrigger = z.infer<typeof StepTriggerSchema>;

export const StepRunStatusSchema = z.enum([
  // Admitted but not yet dispatched: the host was already running as much work
  // as it allows. Queued runs survive a restart and are drained at boot.
  "queued",
  "running",
  "succeeded",
  "failed",
  "interrupted",
  "canceled",
  // Synthetic run recorded by a skip request — no agents/workspaces, exists
  // purely so the hard-gate check (previous step succeeded|skipped) has
  // something to read.
  "skipped",
]);
export type StepRunStatus = z.infer<typeof StepRunStatusSchema>;

export const StepRunSchema = z.object({
  id: z.string(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  status: StepRunStatusSchema,
  agentIds: z.array(z.string()),
  workspaceIds: z.array(z.string()),
  scheduleId: z.string().nullable(),
  error: z.string().nullable(),
});
export type StepRun = z.infer<typeof StepRunSchema>;

export const StepSchema = z.object({
  id: z.string(),
  name: z.string(),
  prompt: z.string().min(1),
  agents: z.array(StepAgentSpecSchema).min(1),
  completion: z.literal("all"),
  workspace: StepWorkspaceStrategySchema,
  trigger: StepTriggerSchema,
  runs: z.array(StepRunSchema),
});
export type Step = z.infer<typeof StepSchema>;

/**
 * The execution attached to a task: an ordered list of steps with hard gates
 * between them. A task has at most one, because the task is the unit of work —
 * a second workflow on the same card would be a second answer to "what is being
 * done here".
 */
export const TaskWorkflowSchema = z.object({
  taskId: z.string(),
  steps: z.array(StepSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type TaskWorkflow = z.infer<typeof TaskWorkflowSchema>;

export const StepInputSchema = StepSchema.omit({ id: true, runs: true });
export type StepInput = z.infer<typeof StepInputSchema>;
