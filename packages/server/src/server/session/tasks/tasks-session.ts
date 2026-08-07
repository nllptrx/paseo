import { randomBytes } from "node:crypto";
import type pino from "pino";
import type { Step, StepInput } from "@getpaseo/protocol/tasks/workflow";
import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";
import type { TaskService } from "../../tasks/service.js";
import type { TaskTransitionEngine } from "../../tasks/transitions.js";
import type { TaskStepIdentifier, TaskWorkflowEngine } from "../../tasks/workflow-engine.js";

export interface TasksSessionHost {
  emit(msg: SessionOutboundMessage): void;
}

export interface TasksSessionOptions {
  host: TasksSessionHost;
  taskService: TaskService;
  transitions: TaskTransitionEngine;
  /** Absent on hosts that never dispatch work; the workflow requests then fail
   * with a reason rather than silently doing nothing. */
  workflowEngine?: TaskWorkflowEngine;
  logger: pino.Logger;
}

type Inbound<T extends SessionInboundMessage["type"]> = Extract<SessionInboundMessage, { type: T }>;

/** Steps arrive without identity: the client describes what to run, the daemon
 * decides what to call each one and starts its run history empty. */
function stampSteps(steps: readonly StepInput[]): Step[] {
  return steps.map((step) => ({
    ...step,
    id: `stp_${randomBytes(4).toString("hex")}`,
    runs: [],
  }));
}

/**
 * A client's tracker request surface.
 *
 * The push carries a revision, not a diff. A client already at that revision has
 * nothing to do; one behind refetches the snapshot. That trade is why the store
 * maintains the counter by trigger — a diff would have to be computed per
 * subscriber, on a write path that also serves agents.
 */
export class TasksSession {
  private readonly host: TasksSessionHost;
  private readonly taskService: TaskService;
  private readonly transitions: TaskTransitionEngine;
  private readonly workflowEngine: TaskWorkflowEngine | null;
  private readonly logger: pino.Logger;
  private unsubscribe: (() => void) | null = null;

  constructor(options: TasksSessionOptions) {
    this.host = options.host;
    this.taskService = options.taskService;
    this.transitions = options.transitions;
    this.workflowEngine = options.workflowEngine ?? null;
    this.logger = options.logger;
  }

  private emitError(request: { requestId: string; type: string }, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.logger.error({ err: error, requestType: request.type }, "Tasks request failed");
    this.host.emit({
      type: "rpc_error",
      payload: {
        requestId: request.requestId,
        requestType: request.type,
        error: message,
        code: "tasks_request_failed",
      },
    });
  }

  async handleSnapshotRequest(request: Inbound<"tasks.snapshot.request">): Promise<void> {
    try {
      const snapshot = await this.taskService.snapshot();
      this.host.emit({
        type: "tasks.snapshot.response",
        payload: { requestId: request.requestId, snapshot, error: null },
      });
    } catch (error) {
      this.emitError(request, error);
    }
  }

  async handleProjectCreateRequest(
    request: Inbound<"tasks.project.create.request">,
  ): Promise<void> {
    try {
      const project = await this.taskService.createProject({
        name: request.name,
        prefix: request.prefix,
        color: request.color,
        paseoProjectId: request.paseoProjectId ?? null,
      });
      this.host.emit({
        type: "tasks.project.create.response",
        payload: { requestId: request.requestId, project, error: null },
      });
    } catch (error) {
      this.emitError(request, error);
    }
  }

  async handleLabelCreateRequest(request: Inbound<"tasks.label.create.request">): Promise<void> {
    try {
      const labelId = await this.taskService.createLabel({
        projectId: request.projectId,
        name: request.name,
        color: request.color,
      });
      this.host.emit({
        type: "tasks.label.create.response",
        payload: { requestId: request.requestId, labelId, error: null },
      });
    } catch (error) {
      this.emitError(request, error);
    }
  }

  async handleCreateRequest(request: Inbound<"tasks.create.request">): Promise<void> {
    try {
      const task = await this.taskService.createTask({
        projectId: request.projectId,
        title: request.title,
        ...(request.description === undefined ? {} : { description: request.description }),
        ...(request.status === undefined ? {} : { status: request.status }),
        ...(request.priority === undefined ? {} : { priority: request.priority }),
        ...(request.dueDate === undefined ? {} : { dueDate: request.dueDate }),
        ...(request.parentTaskId === undefined ? {} : { parentTaskId: request.parentTaskId }),
        ...(request.labelIds === undefined ? {} : { labelIds: request.labelIds }),
      });
      this.host.emit({
        type: "tasks.create.response",
        payload: { requestId: request.requestId, task, error: null },
      });
    } catch (error) {
      this.emitError(request, error);
    }
  }

  async handleUpdateRequest(request: Inbound<"tasks.update.request">): Promise<void> {
    try {
      const task = await this.taskService.updateTask({
        taskId: request.taskId,
        ...(request.title === undefined ? {} : { title: request.title }),
        ...(request.description === undefined ? {} : { description: request.description }),
        ...(request.status === undefined ? {} : { status: request.status }),
        ...(request.priority === undefined ? {} : { priority: request.priority }),
        ...(request.dueDate === undefined ? {} : { dueDate: request.dueDate }),
        ...(request.parentTaskId === undefined ? {} : { parentTaskId: request.parentTaskId }),
        ...(request.labelIds === undefined ? {} : { labelIds: request.labelIds }),
      });
      this.host.emit({
        type: "tasks.update.response",
        payload: { requestId: request.requestId, task, error: null },
      });
    } catch (error) {
      this.emitError(request, error);
    }
  }

  async handleMoveRequest(request: Inbound<"tasks.move.request">): Promise<void> {
    try {
      const task = await this.taskService.moveTask({
        taskId: request.taskId,
        status: request.status,
        beforePosition: request.beforePosition,
        afterPosition: request.afterPosition,
      });
      this.host.emit({
        type: "tasks.move.response",
        payload: { requestId: request.requestId, task, error: null },
      });
    } catch (error) {
      this.emitError(request, error);
    }
  }

  async handleDeleteRequest(request: Inbound<"tasks.delete.request">): Promise<void> {
    try {
      await this.taskService.deleteTask(request.taskId);
      this.host.emit({
        type: "tasks.delete.response",
        payload: { requestId: request.requestId, taskId: request.taskId, error: null },
      });
    } catch (error) {
      this.emitError(request, error);
    }
  }

  async handleAgentAttachRequest(request: Inbound<"tasks.agent.attach.request">): Promise<void> {
    try {
      await this.taskService.attachAgent({
        taskId: request.taskId,
        agentId: request.agentId,
        workspaceId: request.workspaceId,
        presetId: request.presetId ?? null,
      });
      this.transitions.observeAttachment({ taskId: request.taskId, agentId: request.agentId });
      const task = await this.taskService.getTask(request.taskId);
      this.host.emit({
        type: "tasks.agent.attach.response",
        payload: { requestId: request.requestId, task, error: null },
      });
    } catch (error) {
      this.emitError(request, error);
    }
  }

  async handleAgentDetachRequest(request: Inbound<"tasks.agent.detach.request">): Promise<void> {
    try {
      await this.taskService.detachAgent({ taskId: request.taskId, agentId: request.agentId });
      this.transitions.unobserveAttachment({ taskId: request.taskId, agentId: request.agentId });
      const task = await this.taskService.getTask(request.taskId);
      this.host.emit({
        type: "tasks.agent.detach.response",
        payload: { requestId: request.requestId, task, error: null },
      });
    } catch (error) {
      this.emitError(request, error);
    }
  }

  async handleCommentCreateRequest(
    request: Inbound<"tasks.comment.create.request">,
  ): Promise<void> {
    try {
      const comment = await this.taskService.createComment({
        taskId: request.taskId,
        kind: "user",
        authorName: "user",
        body: request.body,
      });
      this.host.emit({
        type: "tasks.comment.create.response",
        payload: { requestId: request.requestId, comment, error: null },
      });
    } catch (error) {
      this.emitError(request, error);
    }
  }

  async handleReviewRequest(request: Inbound<"tasks.review.request">): Promise<void> {
    try {
      const task = await this.transitions.applyReviewVerdict({
        taskId: request.taskId,
        verdict: request.verdict,
      });
      this.host.emit({
        type: "tasks.review.response",
        payload: { requestId: request.requestId, task, error: null },
      });
    } catch (error) {
      this.emitError(request, error);
    }
  }

  async handleBoardConfigureRequest(
    request: Inbound<"tasks.board.configure.request">,
  ): Promise<void> {
    try {
      const project = await this.taskService.configureBoard({
        projectId: request.projectId,
        ...(request.reviewEnabled !== undefined ? { reviewEnabled: request.reviewEnabled } : {}),
        ...(request.reviewOnReject !== undefined ? { reviewOnReject: request.reviewOnReject } : {}),
        ...(request.archiveWorkspacesOnDone !== undefined
          ? { archiveWorkspacesOnDone: request.archiveWorkspacesOnDone }
          : {}),
      });
      this.host.emit({
        type: "tasks.board.configure.response",
        payload: { requestId: request.requestId, project, error: null },
      });
    } catch (error) {
      this.emitError(request, error);
    }
  }

  async handleWorkflowSetRequest(request: Inbound<"tasks.workflow.set.request">): Promise<void> {
    try {
      const workflow = await this.taskService.setWorkflow({
        taskId: request.taskId,
        steps: stampSteps(request.steps),
      });
      this.host.emit({
        type: "tasks.workflow.set.response",
        payload: { requestId: request.requestId, workflow, error: null },
      });
    } catch (error) {
      this.emitError(request, error);
    }
  }

  async handleWorkflowClearRequest(
    request: Inbound<"tasks.workflow.clear.request">,
  ): Promise<void> {
    try {
      await this.taskService.clearWorkflow(request.taskId);
      this.host.emit({
        type: "tasks.workflow.clear.response",
        payload: { requestId: request.requestId, error: null },
      });
    } catch (error) {
      this.emitError(request, error);
    }
  }

  async handleStepRunRequest(request: Inbound<"tasks.step.run.request">): Promise<void> {
    await this.runStepCommand(request, "tasks.step.run.response", (engine, identifier) =>
      engine.runStep(identifier),
    );
  }

  async handleStepRetryRequest(request: Inbound<"tasks.step.retry.request">): Promise<void> {
    await this.runStepCommand(request, "tasks.step.retry.response", (engine, identifier) =>
      engine.retryStep(identifier),
    );
  }

  async handleStepSkipRequest(request: Inbound<"tasks.step.skip.request">): Promise<void> {
    await this.runStepCommand(request, "tasks.step.skip.response", (engine, identifier) =>
      engine.skipStep(identifier),
    );
  }

  async handleStepCancelRequest(request: Inbound<"tasks.step.cancel.request">): Promise<void> {
    await this.runStepCommand(request, "tasks.step.cancel.response", (engine, identifier) =>
      engine.cancelStep(identifier),
    );
  }

  private async runStepCommand(
    request: { requestId: string; type: string; taskId: string; stepId: string },
    responseType:
      | "tasks.step.run.response"
      | "tasks.step.retry.response"
      | "tasks.step.skip.response"
      | "tasks.step.cancel.response",
    command: (engine: TaskWorkflowEngine, identifier: TaskStepIdentifier) => Promise<Step>,
  ): Promise<void> {
    try {
      if (!this.workflowEngine) {
        throw new Error("This host does not run task workflows");
      }
      const step = await command(this.workflowEngine, {
        taskId: request.taskId,
        stepId: request.stepId,
      });
      this.host.emit({
        type: responseType,
        payload: { requestId: request.requestId, step, error: null },
      });
    } catch (error) {
      this.emitError(request, error);
    }
  }

  handleSubscribeRequest(request: Inbound<"tasks.subscribe.request">): void {
    this.unsubscribe?.();
    this.unsubscribe = this.taskService.onRevision((revision) => {
      this.host.emit({ type: "tasks.update", payload: { revision } });
    });
    this.host.emit({
      type: "tasks.subscribe.response",
      payload: { requestId: request.requestId, error: null },
    });
  }

  handleUnsubscribeRequest(request: Inbound<"tasks.unsubscribe.request">): void {
    this.dispose();
    this.host.emit({
      type: "tasks.unsubscribe.response",
      payload: { requestId: request.requestId, error: null },
    });
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }
}
