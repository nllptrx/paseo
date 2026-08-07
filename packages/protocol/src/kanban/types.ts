import { z } from "zod";
import { StepSchema } from "../tasks/workflow.js";

// The step machine now belongs to tasks: a workflow is execution attached to a
// task, not a plan's payload. Re-exported here only while the kanban record is
// still on its way out.
export {
  StepAgentSpecSchema,
  StepWorkspaceStrategySchema,
  StepTriggerSchema,
  StepRunStatusSchema,
  StepRunSchema,
  StepSchema,
} from "../tasks/workflow.js";
export type {
  StepAgentSpec,
  StepWorkspaceStrategy,
  StepTrigger,
  StepRunStatus,
  StepRun,
  Step,
} from "../tasks/workflow.js";

const PlanBaseSchema = z.object({
  id: z.string(),
  title: z.string().min(1),
  description: z.string().nullable(),
  /** The task this plan is execution for, when the tracker holds one. A plan
   * settling green is what moves that task — see docs/kanban-tasks-spec.md §3, "Automatic
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
