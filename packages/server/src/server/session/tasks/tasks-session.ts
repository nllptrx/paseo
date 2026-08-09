import { randomBytes } from "node:crypto";
import type pino from "pino";
import type { Step, StepInput } from "@getpaseo/protocol/tasks/workflow";
import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";
import type { TaskService } from "../../tasks/service.js";
import type { TaskTransitionEngine } from "../../tasks/transitions.js";
import type { TaskStepIdentifier, TaskWorkflowEngine } from "../../tasks/workflow-engine.js";
import {
  formatFeedMentionNotification,
  formatTaskMessageNotification,
  resolveFeedMentions,
} from "../../tasks/feed-mentions.js";

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
  /** Delivers a feed mention to the agent it named. Absent on hosts that only
   * read the tracker; mentions then post without waking anyone. */
  notifyAgent?: (input: { agentId: string; text: string }) => Promise<void>;
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
  private readonly notifyAgent:
    | ((input: { agentId: string; text: string }) => Promise<void>)
    | null;
  private readonly logger: pino.Logger;
  private unsubscribe: (() => void) | null = null;

  constructor(options: TasksSessionOptions) {
    this.host = options.host;
    this.taskService = options.taskService;
    this.transitions = options.transitions;
    this.workflowEngine = options.workflowEngine ?? null;
    this.notifyAgent = options.notifyAgent ?? null;
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
        ...(request.executionPolicy === undefined
          ? {}
          : { executionPolicy: request.executionPolicy }),
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
        ...(request.executionPolicy === undefined
          ? {}
          : { executionPolicy: request.executionPolicy }),
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
        ...(request.feedback !== undefined ? { feedback: request.feedback } : {}),
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
        ...(request.maxReviewIterations !== undefined
          ? { maxReviewIterations: request.maxReviewIterations }
          : {}),
        ...(request.archiveWorkspacesOnDone !== undefined
          ? { archiveWorkspacesOnDone: request.archiveWorkspacesOnDone }
          : {}),
        ...(request.reviewerPresetId !== undefined
          ? { reviewerPresetId: request.reviewerPresetId }
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

  async handleFeedReadRequest(request: Inbound<"tasks.feed.read.request">): Promise<void> {
    try {
      const entries = await this.taskService.listBoardFeed({
        projectId: request.projectId,
        ...(request.limit !== undefined ? { limit: request.limit } : {}),
      });
      this.host.emit({
        type: "tasks.feed.read.response",
        payload: { requestId: request.requestId, entries, error: null },
      });
    } catch (error) {
      this.emitError(request, error);
    }
  }

  async handleFeedPostRequest(request: Inbound<"tasks.feed.post.request">): Promise<void> {
    try {
      // COMPAT(taskMessages): clients before v0.3.0-beta.2 used mentions and
      // notifyTaskAgents on this RPC. An explicit note marker opts into the new
      // history-only behavior; absence retains the released side effect.
      const legacyDelivery = request.entryKind === undefined;
      const mentions = legacyDelivery
        ? resolveFeedMentions({
            body: request.body,
            boardAgentIds: await this.taskService.listBoardAgentIds(request.projectId),
          })
        : { ok: true as const, agentIds: [] };
      if (!mentions.ok) {
        throw new Error(mentions.error);
      }

      const recipients = new Set(mentions.agentIds);
      if (legacyDelivery && request.notifyTaskAgents && request.taskId) {
        for (const agentId of await this.taskService.listTaskAgentIds(request.taskId)) {
          recipients.add(agentId);
        }
      }

      const recipientSnapshot = [...recipients].map((agentId) => ({
        agentId,
        workspaceId: null,
        deliveryStatus: "pending" as const,
      }));
      let entry = await this.taskService.createComment({
        projectId: request.projectId,
        taskId: request.taskId ?? null,
        kind: "user",
        authorName: "user",
        body: request.body,
        entryKind: recipients.size > 0 ? "message" : "note",
        ...(recipientSnapshot.length > 0 ? { recipients: recipientSnapshot } : {}),
      });

      const delivery = await this.notifyMentionedAgents({
        projectId: request.projectId,
        taskId: request.taskId ?? null,
        body: request.body,
        agentIds: [...recipients],
      });
      if (entry.recipients) {
        entry = await this.taskService.updateCommentRecipients(
          entry.id,
          entry.recipients.map((recipient) => ({
            ...recipient,
            deliveryStatus: delivery.get(recipient.agentId) ?? "failed",
          })),
        );
      }

      this.host.emit({
        type: "tasks.feed.post.response",
        payload: { requestId: request.requestId, entry, error: null },
      });
    } catch (error) {
      this.emitError(request, error);
    }
  }

  async handleFeedSendMessageRequest(
    request: Inbound<"tasks.feed.send_message.request">,
  ): Promise<void> {
    try {
      const task = await this.taskService.getTask(request.taskId);
      if (!task || task.projectId !== request.projectId) {
        throw new Error("The message task does not belong to this board");
      }
      const links = await this.taskService.listTaskAgents(request.taskId);
      const linksByAgentId = new Map(links.map((link) => [link.agentId, link]));
      const recipientIds = [...new Set(request.recipientAgentIds)];
      const missing = recipientIds.filter((agentId) => !linksByAgentId.has(agentId));
      if (missing.length > 0) {
        throw new Error(`Message recipients are not attached to this task: ${missing.join(", ")}`);
      }

      let entry = await this.taskService.createComment({
        projectId: request.projectId,
        taskId: request.taskId,
        kind: "user",
        authorName: "user",
        body: request.body,
        entryKind: "message",
        recipients: recipientIds.map((agentId) => ({
          agentId,
          workspaceId: linksByAgentId.get(agentId)?.workspaceId ?? null,
          deliveryStatus: "pending",
        })),
      });

      const project = await this.taskService.getProject(request.projectId);
      const text = project
        ? formatTaskMessageNotification({ project, task, body: request.body })
        : request.body;
      const recipients = await Promise.all(
        entry.recipients?.map(async (recipient) => {
          try {
            if (!this.notifyAgent) throw new Error("Agent delivery is unavailable on this host");
            await this.notifyAgent({ agentId: recipient.agentId, text });
            return { ...recipient, deliveryStatus: "delivered" as const };
          } catch (error) {
            this.logger.warn(
              { err: error, agentId: recipient.agentId, taskId: request.taskId },
              "Could not deliver a task feed message",
            );
            return { ...recipient, deliveryStatus: "failed" as const };
          }
        }) ?? [],
      );
      entry = await this.taskService.updateCommentRecipients(entry.id, recipients);

      this.host.emit({
        type: "tasks.feed.send_message.response",
        payload: { requestId: request.requestId, entry, error: null },
      });
    } catch (error) {
      this.emitError(request, error);
    }
  }

  /**
   * A mention wakes the agent it names. The note is already in the feed by the
   * time this runs, so a prompt that fails to send leaves a board you can read
   * rather than a post that never happened.
   */
  private async notifyMentionedAgents(input: {
    projectId: string;
    taskId: string | null;
    body: string;
    agentIds: readonly string[];
  }): Promise<Map<string, "delivered" | "failed">> {
    const delivery = new Map<string, "delivered" | "failed">();
    if (input.agentIds.length === 0 || !this.notifyAgent) {
      return delivery;
    }
    const project = await this.taskService.getProject(input.projectId);
    if (!project) {
      return delivery;
    }
    const task = input.taskId ? await this.taskService.getTask(input.taskId) : null;
    const text = formatFeedMentionNotification({ project, task, body: input.body });

    await Promise.all(
      input.agentIds.map(async (agentId) => {
        try {
          await this.notifyAgent?.({ agentId, text });
          delivery.set(agentId, "delivered");
        } catch (error) {
          this.logger.warn(
            { err: error, agentId },
            "Could not deliver a feed mention to the agent it named",
          );
          delivery.set(agentId, "failed");
        }
      }),
    );
    return delivery;
  }

  async handleDependencyAddRequest(
    request: Inbound<"tasks.dependency.add.request">,
  ): Promise<void> {
    try {
      await this.taskService.addDependency({
        taskId: request.taskId,
        dependsOnTaskId: request.dependsOnTaskId,
      });
      this.host.emit({
        type: "tasks.dependency.add.response",
        payload: { requestId: request.requestId, error: null },
      });
    } catch (error) {
      this.emitError(request, error);
    }
  }

  async handleDependencyRemoveRequest(
    request: Inbound<"tasks.dependency.remove.request">,
  ): Promise<void> {
    try {
      await this.taskService.removeDependency({
        taskId: request.taskId,
        dependsOnTaskId: request.dependsOnTaskId,
      });
      this.host.emit({
        type: "tasks.dependency.remove.response",
        payload: { requestId: request.requestId, error: null },
      });
    } catch (error) {
      this.emitError(request, error);
    }
  }

  async handlePresetListRequest(request: Inbound<"tasks.preset.list.request">): Promise<void> {
    try {
      const presets = await this.taskService.listPresets();
      this.host.emit({
        type: "tasks.preset.list.response",
        payload: { requestId: request.requestId, presets, error: null },
      });
    } catch (error) {
      this.emitError(request, error);
    }
  }

  async handleDelegateRequest(request: Inbound<"tasks.delegate.request">): Promise<void> {
    try {
      if (!this.workflowEngine) {
        throw new Error("This host does not run task workflows");
      }
      const { agentId } = await this.workflowEngine.delegate({
        taskId: request.taskId,
        ...(request.presetId ? { presetId: request.presetId } : {}),
        ...(request.agent ? { agent: request.agent } : {}),
      });
      this.transitions.observeAttachment({ taskId: request.taskId, agentId });
      this.host.emit({
        type: "tasks.delegate.response",
        payload: { requestId: request.requestId, agentId, error: null },
      });
    } catch (error) {
      this.emitError(request, error);
    }
  }

  async handlePresetCreateRequest(request: Inbound<"tasks.preset.create.request">): Promise<void> {
    try {
      const preset = await this.taskService.createPreset({
        name: request.name,
        provider: request.provider,
        model: request.model ?? null,
        modeId: request.modeId ?? null,
        thinkingOptionId: request.thinkingOptionId ?? null,
        instructions: request.instructions ?? "",
        environmentKind: request.environmentKind,
        baseBranch: request.baseBranch ?? null,
      });
      this.host.emit({
        type: "tasks.preset.create.response",
        payload: { requestId: request.requestId, preset, error: null },
      });
    } catch (error) {
      this.emitError(request, error);
    }
  }

  async handlePresetDeleteRequest(request: Inbound<"tasks.preset.delete.request">): Promise<void> {
    try {
      await this.taskService.deletePreset(request.presetId);
      this.host.emit({
        type: "tasks.preset.delete.response",
        payload: { requestId: request.requestId, error: null },
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
