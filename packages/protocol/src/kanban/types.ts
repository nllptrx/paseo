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
  "running",
  "succeeded",
  "failed",
  "interrupted",
  "canceled",
  // Synthetic run recorded by `kanban.step.skip.request` — no agents/workspaces,
  // exists purely so the hard-gate check (previous step succeeded|skipped) has
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

const PlanBaseSchema = z.object({
  id: z.string(),
  title: z.string().min(1),
  description: z.string().nullable(),
  /** The task this plan is execution for, when the tracker holds one. A plan
   * settling green is what moves that task — see docs/tasks.md, "Automatic
   * transitions". Optional on the wire: records written before the field are
   * plans that simply move nothing. */
  taskId: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  archivedAt: z.string().nullable(),
});

export const NestedPlanSchema = PlanBaseSchema.extend({
  body: z.object({
    type: z.literal("workflow"),
    steps: z.array(StepSchema),
  }),
});
export type NestedPlan = z.infer<typeof NestedPlanSchema>;

export const KanbanPlanSchema = PlanBaseSchema.extend({
  body: z.discriminatedUnion("type", [
    z.object({ type: z.literal("workflow"), steps: z.array(StepSchema) }),
    z.object({
      type: z.literal("nested_kanban"),
      plans: z.record(z.string(), NestedPlanSchema),
    }),
  ]),
});
export type KanbanPlan = z.infer<typeof KanbanPlanSchema>;

/**
 * What happens to a task when its attached work settles green. `enabled` routes
 * it to `in_review` instead of `done`; `onReject` is where a rejected review
 * sends it back to. Optional on the wire — a record without it reviews nothing.
 */
export const KanbanReviewConfigSchema = z.object({
  enabled: z.boolean(),
  onReject: z.enum(["in_progress", "todo", "backlog"]),
});
export type KanbanReviewConfig = z.infer<typeof KanbanReviewConfigSchema>;

export const StoredKanbanSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  /** Archive the worktrees a plan's steps created once every step has finished.
   * Columns are derived, so this hangs off the plan reaching that state rather
   * than off entering a column. */
  archiveWorkspacesOnDone: z.boolean(),
  review: KanbanReviewConfigSchema.optional(),
  plans: z.record(z.string(), KanbanPlanSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
  archivedAt: z.string().nullable(),
});
export type StoredKanban = z.infer<typeof StoredKanbanSchema>;

export const KanbanSummarySchema = StoredKanbanSchema.omit({ plans: true });
export type KanbanSummary = z.infer<typeof KanbanSummarySchema>;
