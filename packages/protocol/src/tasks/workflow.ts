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
  /** Where the checkout stood when this run began, so "did it change anything"
   * can be answered without an upstream to compare against — a fresh worktree
   * has none until it is pushed. */
  startCommit: z.string().nullable().optional(),
  error: z.string().nullable(),
});
export type StepRun = z.infer<typeof StepRunSchema>;

/**
 * A command that has to pass before a step counts as done. An argv, never a
 * shell string: what runs is what the author listed, with nothing interpolated
 * into a command line on the way.
 */
export const StepVerificationSchema = z.object({
  command: z.array(z.string().trim().min(1)).min(1),
  timeoutMs: z.number().int().positive().max(3_600_000).optional(),
});
export type StepVerification = z.infer<typeof StepVerificationSchema>;

export const StepSchema = z.object({
  id: z.string(),
  name: z.string(),
  prompt: z.string().min(1),
  agents: z.array(StepAgentSpecSchema).min(1),
  completion: z.literal("all"),
  workspace: StepWorkspaceStrategySchema,
  trigger: StepTriggerSchema,
  /** Refuse to call the step done when its workspace is untouched. An agent
   * that stopped is not an agent that did something. */
  requireChanges: z.boolean().optional(),
  verify: StepVerificationSchema.optional(),
  /** Wall-clock ceiling for one run of this step. An agent looping forever
   * reads as running forever, and nothing else would ever stop it. */
  timeoutMs: z.number().int().positive().max(86_400_000).optional(),
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
