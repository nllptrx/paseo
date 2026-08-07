import type pino from "pino";
import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";
import type { TaskService } from "../../tasks/service.js";

export interface TasksSessionHost {
  emit(msg: SessionOutboundMessage): void;
}

export interface TasksSessionOptions {
  host: TasksSessionHost;
  taskService: TaskService;
  logger: pino.Logger;
}

type Inbound<T extends SessionInboundMessage["type"]> = Extract<SessionInboundMessage, { type: T }>;

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
  private readonly logger: pino.Logger;
  private unsubscribe: (() => void) | null = null;

  constructor(options: TasksSessionOptions) {
    this.host = options.host;
    this.taskService = options.taskService;
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
