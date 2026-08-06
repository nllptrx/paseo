import { z } from "zod";
import { KanbanPlanSchema, KanbanSummarySchema, StepSchema, StoredKanbanSchema } from "./types.js";

export const StepInputSchema = StepSchema.omit({ id: true, runs: true });
export type StepInput = z.infer<typeof StepInputSchema>;

export const KanbanPlanCreateBodySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("workflow"), steps: z.array(StepInputSchema) }),
  z.object({ type: z.literal("nested_kanban") }),
]);
export type KanbanPlanCreateBody = z.infer<typeof KanbanPlanCreateBodySchema>;

export const KanbanListRequestSchema = z.object({
  type: z.literal("kanban.list.request"),
  requestId: z.string(),
});

export const KanbanListResponseSchema = z.object({
  type: z.literal("kanban.list.response"),
  payload: z.object({
    requestId: z.string(),
    kanbans: z.array(KanbanSummarySchema),
    error: z.string().nullable(),
  }),
});

export const KanbanGetRequestSchema = z.object({
  type: z.literal("kanban.get.request"),
  requestId: z.string(),
  kanbanId: z.string(),
});

export const KanbanGetResponseSchema = z.object({
  type: z.literal("kanban.get.response"),
  payload: z.object({
    requestId: z.string(),
    kanban: StoredKanbanSchema.nullable(),
    error: z.string().nullable(),
  }),
});

export const KanbanCreateRequestSchema = z.object({
  type: z.literal("kanban.create.request"),
  requestId: z.string(),
  projectId: z.string().trim().min(1),
  name: z.string().trim().min(1).optional(),
});

export const KanbanCreateResponseSchema = z.object({
  type: z.literal("kanban.create.response"),
  payload: z.object({
    requestId: z.string(),
    kanban: StoredKanbanSchema.nullable(),
    error: z.string().nullable(),
  }),
});

export const KanbanUpdateRequestSchema = z.object({
  type: z.literal("kanban.update.request"),
  requestId: z.string(),
  kanbanId: z.string(),
  name: z.string().trim().min(1).optional(),
  archiveWorkspacesOnDone: z.boolean().optional(),
});

export const KanbanUpdateResponseSchema = z.object({
  type: z.literal("kanban.update.response"),
  payload: z.object({
    requestId: z.string(),
    kanban: StoredKanbanSchema.nullable(),
    error: z.string().nullable(),
  }),
});

export const KanbanArchiveRequestSchema = z.object({
  type: z.literal("kanban.archive.request"),
  requestId: z.string(),
  kanbanId: z.string(),
});

export const KanbanArchiveResponseSchema = z.object({
  type: z.literal("kanban.archive.response"),
  payload: z.object({
    requestId: z.string(),
    kanbanId: z.string(),
    error: z.string().nullable(),
  }),
});

export const KanbanPlanCreateRequestSchema = z.object({
  type: z.literal("kanban.plan.create.request"),
  requestId: z.string(),
  kanbanId: z.string(),
  parentPlanId: z.string().nullable().optional(),
  title: z.string().trim().min(1),
  description: z.string().trim().min(1).nullable().optional(),
  body: KanbanPlanCreateBodySchema,
});

export const KanbanPlanCreateResponseSchema = z.object({
  type: z.literal("kanban.plan.create.response"),
  payload: z.object({
    requestId: z.string(),
    plan: KanbanPlanSchema.nullable(),
    error: z.string().nullable(),
  }),
});

export const KanbanPlanUpdateRequestSchema = z.object({
  type: z.literal("kanban.plan.update.request"),
  requestId: z.string(),
  kanbanId: z.string(),
  parentPlanId: z.string().nullable().optional(),
  planId: z.string(),
  title: z.string().trim().min(1).optional(),
  description: z.string().trim().min(1).nullable().optional(),
});

export const KanbanPlanUpdateResponseSchema = z.object({
  type: z.literal("kanban.plan.update.response"),
  payload: z.object({
    requestId: z.string(),
    plan: KanbanPlanSchema.nullable(),
    error: z.string().nullable(),
  }),
});

export const KanbanPlanArchiveRequestSchema = z.object({
  type: z.literal("kanban.plan.archive.request"),
  requestId: z.string(),
  kanbanId: z.string(),
  parentPlanId: z.string().nullable().optional(),
  planId: z.string(),
});

export const KanbanPlanArchiveResponseSchema = z.object({
  type: z.literal("kanban.plan.archive.response"),
  payload: z.object({
    requestId: z.string(),
    planId: z.string(),
    error: z.string().nullable(),
  }),
});

const KanbanStepActionRequestSchema = z.object({
  requestId: z.string(),
  kanbanId: z.string(),
  parentPlanId: z.string().nullable().optional(),
  planId: z.string(),
  stepId: z.string(),
});

export const KanbanStepRunRequestSchema = KanbanStepActionRequestSchema.extend({
  type: z.literal("kanban.step.run.request"),
});

export const KanbanStepRunResponseSchema = z.object({
  type: z.literal("kanban.step.run.response"),
  payload: z.object({
    requestId: z.string(),
    step: StepSchema.nullable(),
    error: z.string().nullable(),
  }),
});

export const KanbanStepRetryRequestSchema = KanbanStepActionRequestSchema.extend({
  type: z.literal("kanban.step.retry.request"),
});

export const KanbanStepRetryResponseSchema = z.object({
  type: z.literal("kanban.step.retry.response"),
  payload: z.object({
    requestId: z.string(),
    step: StepSchema.nullable(),
    error: z.string().nullable(),
  }),
});

export const KanbanStepSkipRequestSchema = KanbanStepActionRequestSchema.extend({
  type: z.literal("kanban.step.skip.request"),
});

export const KanbanStepSkipResponseSchema = z.object({
  type: z.literal("kanban.step.skip.response"),
  payload: z.object({
    requestId: z.string(),
    step: StepSchema.nullable(),
    error: z.string().nullable(),
  }),
});

export const KanbanStepCancelRequestSchema = KanbanStepActionRequestSchema.extend({
  type: z.literal("kanban.step.cancel.request"),
});

export const KanbanStepCancelResponseSchema = z.object({
  type: z.literal("kanban.step.cancel.response"),
  payload: z.object({
    requestId: z.string(),
    step: StepSchema.nullable(),
    error: z.string().nullable(),
  }),
});

export const KanbanOrchestratorProvisionRequestSchema = z.object({
  type: z.literal("kanban.orchestrator.provision.request"),
  requestId: z.string(),
  kanbanId: z.string(),
});

export const KanbanOrchestratorProvisionResponseSchema = z.object({
  type: z.literal("kanban.orchestrator.provision.response"),
  payload: z.object({
    requestId: z.string(),
    kanban: StoredKanbanSchema.nullable(),
    error: z.string().nullable(),
  }),
});

export const KanbanOrchestratorUnlinkRequestSchema = z.object({
  type: z.literal("kanban.orchestrator.unlink.request"),
  requestId: z.string(),
  kanbanId: z.string(),
});

export const KanbanOrchestratorUnlinkResponseSchema = z.object({
  type: z.literal("kanban.orchestrator.unlink.response"),
  payload: z.object({
    requestId: z.string(),
    kanban: StoredKanbanSchema.nullable(),
    error: z.string().nullable(),
  }),
});

export const OrchestratorPeerSchema = z.object({
  kanbanId: z.string(),
  kanbanName: z.string(),
  projectId: z.string(),
  workspaceId: z.string(),
  agentId: z.string(),
  agentTitle: z.string().nullable(),
  agentLastStatus: z.string().nullable(),
  attention: z.boolean(),
});
export type OrchestratorPeer = z.infer<typeof OrchestratorPeerSchema>;

export const KanbanOrchestratorListPeersRequestSchema = z.object({
  type: z.literal("kanban.orchestrator.list_peers.request"),
  requestId: z.string(),
});

export const KanbanOrchestratorListPeersResponseSchema = z.object({
  type: z.literal("kanban.orchestrator.list_peers.response"),
  payload: z.object({
    requestId: z.string(),
    peers: z.array(OrchestratorPeerSchema),
    error: z.string().nullable(),
  }),
});

export const KanbanSubscribeRequestSchema = z.object({
  type: z.literal("kanban.subscribe.request"),
  requestId: z.string(),
});

export const KanbanSubscribeResponseSchema = z.object({
  type: z.literal("kanban.subscribe.response"),
  payload: z.object({
    requestId: z.string(),
    error: z.string().nullable(),
  }),
});

export const KanbanUnsubscribeRequestSchema = z.object({
  type: z.literal("kanban.unsubscribe.request"),
  requestId: z.string(),
});

export const KanbanUnsubscribeResponseSchema = z.object({
  type: z.literal("kanban.unsubscribe.response"),
  payload: z.object({
    requestId: z.string(),
    error: z.string().nullable(),
  }),
});

export const KanbanUpdatePushSchema = z.object({
  type: z.literal("kanban.update"),
  payload: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("upsert"), kanban: StoredKanbanSchema }),
    z.object({ kind: z.literal("remove"), kanbanId: z.string() }),
  ]),
});
