import type pino from "pino";
import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";
import type { KanbanEngine } from "../../kanban/engine.js";
import type { KanbanService } from "../../kanban/service.js";
import {
  provisionKanbanOrchestrator,
  type OrchestratorProvisioningDeps,
} from "../../kanban/orchestrator-provisioning.js";

export interface KanbanSessionHost {
  emit(msg: SessionOutboundMessage): void;
}

export type KanbanOrchestratorProvisioningDeps = Omit<
  OrchestratorProvisioningDeps,
  "kanbanService" | "logger"
>;

export interface KanbanSessionOptions {
  host: KanbanSessionHost;
  kanbanService: KanbanService;
  kanbanEngine: KanbanEngine;
  logger: pino.Logger;
  // Optional: orchestrator provisioning needs a project registry, workspace
  // provisioning, and agent-creation collaborators that most callers (tests that
  // never provision an Orchestrator) don't need to construct.
  orchestratorProvisioning?: KanbanOrchestratorProvisioningDeps;
}

/**
 * A client's kanban request surface: board/plan CRUD, step
 * run/retry/skip/cancel, orchestrator provision/unlink/peer-listing, and the
 * kanban.update push subscription. Plan moves and step actions go through
 * `kanbanEngine` (not `kanbanService` directly) so column-entry automations and
 * the workflow gate machinery run on every move/action regardless of caller.
 */
export class KanbanSession {
  private readonly host: KanbanSessionHost;
  private readonly kanbanService: KanbanService;
  private readonly kanbanEngine: KanbanEngine;
  private readonly logger: pino.Logger;
  private readonly orchestratorProvisioning?: KanbanOrchestratorProvisioningDeps;
  private unsubscribeKanbanChanges: (() => void) | null = null;

  constructor(options: KanbanSessionOptions) {
    this.host = options.host;
    this.kanbanService = options.kanbanService;
    this.kanbanEngine = options.kanbanEngine;
    this.logger = options.logger;
    this.orchestratorProvisioning = options.orchestratorProvisioning;
  }

  private emitKanbanRpcError(request: { requestId: string; type: string }, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.logger.error({ err: error, requestType: request.type }, "Kanban request failed");
    this.host.emit({
      type: "rpc_error",
      payload: {
        requestId: request.requestId,
        requestType: request.type,
        error: message,
        code: "kanban_request_failed",
      },
    });
  }

  async handleListRequest(
    request: Extract<SessionInboundMessage, { type: "kanban.list.request" }>,
  ): Promise<void> {
    try {
      const kanbans = await this.kanbanService.list();
      this.host.emit({
        type: "kanban.list.response",
        payload: { requestId: request.requestId, kanbans, error: null },
      });
    } catch (error) {
      this.emitKanbanRpcError(request, error);
    }
  }

  async handleGetRequest(
    request: Extract<SessionInboundMessage, { type: "kanban.get.request" }>,
  ): Promise<void> {
    try {
      const kanban = await this.kanbanService.get(request.kanbanId);
      this.host.emit({
        type: "kanban.get.response",
        payload: { requestId: request.requestId, kanban, error: null },
      });
    } catch (error) {
      this.emitKanbanRpcError(request, error);
    }
  }

  async handleCreateRequest(
    request: Extract<SessionInboundMessage, { type: "kanban.create.request" }>,
  ): Promise<void> {
    try {
      const kanban = await this.kanbanService.getOrCreateForProject(request.projectId, {
        name: request.name,
      });
      this.host.emit({
        type: "kanban.create.response",
        payload: { requestId: request.requestId, kanban, error: null },
      });
    } catch (error) {
      this.emitKanbanRpcError(request, error);
    }
  }

  async handleUpdateRequest(
    request: Extract<SessionInboundMessage, { type: "kanban.update.request" }>,
  ): Promise<void> {
    try {
      const kanban = await this.kanbanService.update(request.kanbanId, {
        name: request.name,
        archiveWorkspacesOnDone: request.archiveWorkspacesOnDone,
        review: request.review,
      });
      this.host.emit({
        type: "kanban.update.response",
        payload: { requestId: request.requestId, kanban, error: null },
      });
    } catch (error) {
      this.emitKanbanRpcError(request, error);
    }
  }

  async handleArchiveRequest(
    request: Extract<SessionInboundMessage, { type: "kanban.archive.request" }>,
  ): Promise<void> {
    try {
      await this.kanbanService.archive(request.kanbanId);
      this.host.emit({
        type: "kanban.archive.response",
        payload: { requestId: request.requestId, kanbanId: request.kanbanId, error: null },
      });
    } catch (error) {
      this.emitKanbanRpcError(request, error);
    }
  }

  async handlePlanCreateRequest(
    request: Extract<SessionInboundMessage, { type: "kanban.plan.create.request" }>,
  ): Promise<void> {
    try {
      const plan = await this.kanbanService.createPlan({
        kanbanId: request.kanbanId,
        parentPlanId: request.parentPlanId,
        title: request.title,
        description: request.description,
        taskId: request.taskId,
        body: request.body,
      });
      this.host.emit({
        type: "kanban.plan.create.response",
        payload: { requestId: request.requestId, plan, error: null },
      });
    } catch (error) {
      this.emitKanbanRpcError(request, error);
    }
  }

  async handlePlanUpdateRequest(
    request: Extract<SessionInboundMessage, { type: "kanban.plan.update.request" }>,
  ): Promise<void> {
    try {
      const plan = await this.kanbanService.updatePlan({
        kanbanId: request.kanbanId,
        parentPlanId: request.parentPlanId,
        planId: request.planId,
        title: request.title,
        description: request.description,
      });
      this.host.emit({
        type: "kanban.plan.update.response",
        payload: { requestId: request.requestId, plan, error: null },
      });
    } catch (error) {
      this.emitKanbanRpcError(request, error);
    }
  }

  async handleStepRunRequest(
    request: Extract<SessionInboundMessage, { type: "kanban.step.run.request" }>,
  ): Promise<void> {
    try {
      const step = await this.kanbanEngine.runStep({
        kanbanId: request.kanbanId,
        parentPlanId: request.parentPlanId,
        planId: request.planId,
        stepId: request.stepId,
      });
      this.host.emit({
        type: "kanban.step.run.response",
        payload: { requestId: request.requestId, step, error: null },
      });
    } catch (error) {
      this.emitKanbanRpcError(request, error);
    }
  }

  async handleStepRetryRequest(
    request: Extract<SessionInboundMessage, { type: "kanban.step.retry.request" }>,
  ): Promise<void> {
    try {
      const step = await this.kanbanEngine.retryStep({
        kanbanId: request.kanbanId,
        parentPlanId: request.parentPlanId,
        planId: request.planId,
        stepId: request.stepId,
      });
      this.host.emit({
        type: "kanban.step.retry.response",
        payload: { requestId: request.requestId, step, error: null },
      });
    } catch (error) {
      this.emitKanbanRpcError(request, error);
    }
  }

  async handleStepSkipRequest(
    request: Extract<SessionInboundMessage, { type: "kanban.step.skip.request" }>,
  ): Promise<void> {
    try {
      const step = await this.kanbanEngine.skipStep({
        kanbanId: request.kanbanId,
        parentPlanId: request.parentPlanId,
        planId: request.planId,
        stepId: request.stepId,
      });
      this.host.emit({
        type: "kanban.step.skip.response",
        payload: { requestId: request.requestId, step, error: null },
      });
    } catch (error) {
      this.emitKanbanRpcError(request, error);
    }
  }

  async handleStepCancelRequest(
    request: Extract<SessionInboundMessage, { type: "kanban.step.cancel.request" }>,
  ): Promise<void> {
    try {
      const step = await this.kanbanEngine.cancelStep({
        kanbanId: request.kanbanId,
        parentPlanId: request.parentPlanId,
        planId: request.planId,
        stepId: request.stepId,
      });
      this.host.emit({
        type: "kanban.step.cancel.response",
        payload: { requestId: request.requestId, step, error: null },
      });
    } catch (error) {
      this.emitKanbanRpcError(request, error);
    }
  }

  async handlePlanArchiveRequest(
    request: Extract<SessionInboundMessage, { type: "kanban.plan.archive.request" }>,
  ): Promise<void> {
    try {
      await this.kanbanService.archivePlan({
        kanbanId: request.kanbanId,
        parentPlanId: request.parentPlanId,
        planId: request.planId,
      });
      this.host.emit({
        type: "kanban.plan.archive.response",
        payload: { requestId: request.requestId, planId: request.planId, error: null },
      });
    } catch (error) {
      this.emitKanbanRpcError(request, error);
    }
  }

  async handleOrchestratorProvisionRequest(
    request: Extract<SessionInboundMessage, { type: "kanban.orchestrator.provision.request" }>,
  ): Promise<void> {
    try {
      if (!this.orchestratorProvisioning) {
        throw new Error("Orchestrator provisioning is not configured on this daemon");
      }
      const kanban = await provisionKanbanOrchestrator(
        {
          ...this.orchestratorProvisioning,
          kanbanService: this.kanbanService,
          logger: this.logger,
        },
        request.kanbanId,
      );
      this.host.emit({
        type: "kanban.orchestrator.provision.response",
        payload: { requestId: request.requestId, kanban, error: null },
      });
    } catch (error) {
      this.emitKanbanRpcError(request, error);
    }
  }

  async handleOrchestratorUnlinkRequest(
    request: Extract<SessionInboundMessage, { type: "kanban.orchestrator.unlink.request" }>,
  ): Promise<void> {
    try {
      const kanban = await this.kanbanService.get(request.kanbanId);
      this.host.emit({
        type: "kanban.orchestrator.unlink.response",
        payload: { requestId: request.requestId, kanban, error: null },
      });
    } catch (error) {
      this.emitKanbanRpcError(request, error);
    }
  }

  async handleOrchestratorListPeersRequest(
    request: Extract<SessionInboundMessage, { type: "kanban.orchestrator.list_peers.request" }>,
  ): Promise<void> {
    try {
      const peers = await this.kanbanService.listOrchestratorPeers();
      this.host.emit({
        type: "kanban.orchestrator.list_peers.response",
        payload: { requestId: request.requestId, peers, error: null },
      });
    } catch (error) {
      this.emitKanbanRpcError(request, error);
    }
  }

  async handleSubscribeRequest(
    request: Extract<SessionInboundMessage, { type: "kanban.subscribe.request" }>,
  ): Promise<void> {
    try {
      this.unsubscribeKanbanChanges?.();
      this.unsubscribeKanbanChanges = this.kanbanService.onChange((event) => {
        this.host.emit({ type: "kanban.update", payload: event });
      });
      this.host.emit({
        type: "kanban.subscribe.response",
        payload: { requestId: request.requestId, error: null },
      });
    } catch (error) {
      this.emitKanbanRpcError(request, error);
    }
  }

  async handleUnsubscribeRequest(
    request: Extract<SessionInboundMessage, { type: "kanban.unsubscribe.request" }>,
  ): Promise<void> {
    try {
      this.unsubscribeKanbanChanges?.();
      this.unsubscribeKanbanChanges = null;
      this.host.emit({
        type: "kanban.unsubscribe.response",
        payload: { requestId: request.requestId, error: null },
      });
    } catch (error) {
      this.emitKanbanRpcError(request, error);
    }
  }

  dispose(): void {
    this.unsubscribeKanbanChanges?.();
    this.unsubscribeKanbanChanges = null;
  }
}
