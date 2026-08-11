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
  logger: pino.Logger;
}

type Inbound<T extends SessionInboundMessage["type"]> = Extract<SessionInboundMessage, { type: T }>;

/** New steps receive daemon-owned identity. Existing steps keep the identity
 * and run history named by the editor; changing a plan must not make completed
 * work read as not started. */
function stampSteps(steps: readonly StepInput[], existingSteps: readonly Step[]): Step[] {
  const existingById = new Map(existingSteps.map((step) => [step.id, step]));
  const retainedIds = new Set<string>();
  return steps.map((input) => {
    const { existingStepId, ...step } = input;
    const existing = existingStepId ? existingById.get(existingStepId) : undefined;
    if (existing && !retainedIds.has(existing.id)) {
      retainedIds.add(existing.id);
      return { ...step, id: existing.id, runs: existing.runs };
    }
    return {
      ...step,
      id: `stp_${randomBytes(4).toString("hex")}`,
      runs: [],
    };
  });
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

  async handleLabelDeleteRequest(request: Inbound<"tasks.label.delete.request">): Promise<void> {
    try {
      await this.taskService.deleteLabel(request.labelId);
      this.host.emit({
        type: "tasks.label.delete.response",
        payload: { requestId: request.requestId, labelId: request.labelId, error: null },
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
        ...(request.executionSpec === undefined ? {} : { executionSpec: request.executionSpec }),
        ...(request.parallel === undefined ? {} : { parallel: request.parallel }),
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
        ...(request.executionSpec === undefined ? {} : { executionSpec: request.executionSpec }),
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

  /**
   * Start review, by hand. It refuses anywhere but `in_review`: the gesture
   * exists for a card that is waiting on a verdict, and arming a reviewer for a
   * card still being worked on would judge an unfinished branch.
   */
  async handleReviewStartRequest(request: Inbound<"tasks.review.start.request">): Promise<void> {
    try {
      const task = await this.taskService.getTask(request.taskId);
      if (!task) {
        throw new Error(`No task ${request.taskId} to review`);
      }
      if (task.status !== "in_review") {
        throw new Error(
          `Task ${request.taskId} is ${task.status}, not in review, so there is no review to start`,
        );
      }
      await this.transitions.startReviewIfIdle(request.taskId);
      this.host.emit({
        type: "tasks.review.start.response",
        payload: { requestId: request.requestId, taskId: request.taskId, error: null },
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
      const existing = await this.taskService.getWorkflow(request.taskId);
      let workflow = await this.taskService.setWorkflow({
        taskId: request.taskId,
        steps: stampSteps(request.steps, existing?.steps ?? []),
      });
      if (this.workflowEngine) {
        try {
          await this.workflowEngine.continueReadyWorkflow(request.taskId);
          workflow = (await this.taskService.getWorkflow(request.taskId)) ?? workflow;
        } catch (error) {
          this.logger.error(
            { err: error, taskId: request.taskId },
            "Failed to continue edited task workflow",
          );
        }
      }
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

      const project = await this.taskService.getProject(request.projectId);
      const task = request.taskId ? await this.taskService.getTask(request.taskId) : null;
      const text = project
        ? formatFeedMentionNotification({ project, task, body: request.body })
        : request.body;
      const entry = await this.taskService.writeFeedEntry({
        projectId: request.projectId,
        taskId: request.taskId ?? null,
        kind: "user",
        authorName: "user",
        body: request.body,
        entryKind: "note",
        ...(recipients.size > 0
          ? {
              delivery: {
                scope: "board",
                agentIds: [...recipients],
                text,
              } as const,
            }
          : {}),
      });

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
      const recipientIds = [...new Set(request.recipientAgentIds)];
      const project = await this.taskService.getProject(request.projectId);
      const text = project
        ? formatTaskMessageNotification({ project, task, body: request.body })
        : request.body;
      const entry = await this.taskService.writeFeedEntry({
        projectId: request.projectId,
        taskId: request.taskId,
        kind: "user",
        authorName: "user",
        body: request.body,
        delivery: { scope: "task", agentIds: recipientIds, text },
      });

      this.host.emit({
        type: "tasks.feed.send_message.response",
        payload: { requestId: request.requestId, entry, error: null },
      });
    } catch (error) {
      this.emitError(request, error);
    }
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
        featureValues: request.featureValues,
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
