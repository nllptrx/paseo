import type {
  Task,
  TaskAgentLink,
  TaskBoardConfig,
  TaskComment,
  TaskPreset,
  TaskProject,
  TaskSnapshot,
  TaskStatus,
  TaskBoardEvent,
} from "@getpaseo/protocol/tasks/types";
import type { Step, TaskWorkflow } from "@getpaseo/protocol/tasks/workflow";
import type pino from "pino";
import {
  renderBoardEvent,
  toTaskBoardEvent,
  type BoardEventInput,
  type BoardEventKind,
} from "./board-events.js";
import {
  DEFAULT_TASK_STATUS,
  openTaskStore,
  type CreateTaskCommentInput,
  type CreateTaskInput,
  type CreateTaskPresetInput,
  type TaskAgentRole,
  type TaskAgentCompletionOwner,
  type CreateTaskProjectInput,
  type TaskStore,
  type UpdateTaskInput,
} from "./store.js";

export type TaskRevisionListener = (revision: number) => void;

/** Daemon rules consume the same typed event that the feed stores. */
export type BoardEventListener = (event: TaskBoardEvent) => void;

export interface BoardEventCause {
  kind: BoardEventKind;
  agentId?: string;
  verdict?: "approve" | "reject";
  cause: string;
}

export type UpdateTaskWithEventInput = UpdateTaskInput & {
  boardEvent?: BoardEventCause;
};

/** Either a task (the board comes from it) or a board directly. */
export type CreateFeedEntryInput = Omit<CreateTaskCommentInput, "projectId"> & {
  projectId?: string;
};

export interface FeedDeliveryInput {
  scope: "board" | "task";
  agentIds: readonly string[];
  text: string;
}

export type WriteFeedEntryInput = CreateFeedEntryInput & {
  delivery?: FeedDeliveryInput;
};

/**
 * The tracker, and the one place that decides whether there is one.
 *
 * The store is opened on first use rather than at boot. A runtime without the
 * built-in SQLite driver, or a `tasks.db` this build cannot read, leaves the
 * tracker unavailable and everything else running — the daemon's other work has
 * nothing to do with tasks, and should not go down with them.
 */
export class TaskService {
  private readonly databasePath: string;
  private readonly logger: pino.Logger;
  private readonly listeners = new Set<TaskRevisionListener>();
  private opening: Promise<TaskStore> | null = null;
  private unavailableReason: string | null = null;
  private available = false;
  private completeTaskHandler: ((taskId: string) => Promise<Task>) | null = null;
  private reviewEntryHandler: ((taskId: string) => Promise<void>) | null = null;
  private boardEventListener: BoardEventListener | null = null;
  private feedDeliveryHandler:
    | ((input: { agentId: string; text: string }) => Promise<void>)
    | null = null;

  constructor(input: { databasePath: string; logger: pino.Logger }) {
    this.databasePath = input.databasePath;
    this.logger = input.logger;
  }

  /**
   * Null once opening has failed. Callers gate on this instead of catching:
   * a tracker that could not open will not open on the next request either, so
   * retrying per request would just repeat the same failure under load.
   */
  private async store(): Promise<TaskStore | null> {
    if (this.unavailableReason !== null) {
      return null;
    }
    if (!this.opening) {
      this.opening = openTaskStore({ databasePath: this.databasePath, logger: this.logger });
    }
    try {
      const store = await this.opening;
      this.available = true;
      return store;
    } catch (error) {
      this.unavailableReason = error instanceof Error ? error.message : String(error);
      this.opening = null;
      this.logger.warn(
        { err: error, databasePath: this.databasePath },
        "Tasks are unavailable: the store could not be opened",
      );
      return null;
    }
  }

  async isAvailable(): Promise<boolean> {
    return (await this.store()) !== null;
  }

  /**
   * The answer `server_info` can give, which has to be synchronous. It is false
   * until the store has been opened once, so the daemon warms it at boot: a
   * client connecting must be told whether the tracker exists before it decides
   * to show it, and "not probed yet" is not something the wire can say.
   */
  get isAvailableNow(): boolean {
    return this.available;
  }

  onRevision(listener: TaskRevisionListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Called after every write, with the revision the write produced. Listeners
   * push it; a client already at that revision does nothing. */
  private announce(store: TaskStore): void {
    const revision = store.getRevision();
    for (const listener of this.listeners) {
      try {
        listener(revision);
      } catch (error) {
        this.logger.warn({ err: error }, "A task revision listener threw");
      }
    }
  }

  private async require(): Promise<TaskStore> {
    const store = await this.store();
    if (!store) {
      throw new Error(this.unavailableReason ?? "Tasks are unavailable on this host");
    }
    return store;
  }

  async snapshot(): Promise<TaskSnapshot> {
    return (await this.require()).snapshot();
  }

  async getTask(taskId: string): Promise<Task | null> {
    return (await this.require()).getTask(taskId);
  }

  async getProject(projectId: string): Promise<TaskProject | null> {
    return (await this.require()).getProject(projectId);
  }

  /** The board for a Paseo project, when its checkout has a tracker. */
  async findProjectByPaseoProjectId(paseoProjectId: string): Promise<TaskProject | null> {
    return (await this.require()).findProjectByPaseoProjectId(paseoProjectId);
  }

  async configureBoard(input: {
    projectId: string;
    reviewEnabled?: boolean;
    reviewOnReject?: TaskBoardConfig["reviewOnReject"];
    archiveWorkspacesOnDone?: boolean;
    reviewerPresetId?: string | null;
    maxReviewIterations?: number;
  }): Promise<TaskProject> {
    const store = await this.require();
    const project = store.configureBoard(input);
    this.announce(store);
    return project;
  }

  // --- Workflows ---

  async getWorkflow(taskId: string): Promise<TaskWorkflow | null> {
    return (await this.require()).getWorkflow(taskId);
  }

  async setWorkflow(input: { taskId: string; steps: readonly Step[] }): Promise<TaskWorkflow> {
    for (const step of input.steps) {
      if (step.trigger.type === "schedule" && step.agents.length !== 1) {
        throw new Error(
          `Step ${step.id} uses a schedule and must have exactly one agent; scheduled fan-out is not supported`,
        );
      }
    }
    const store = await this.require();
    const workflow = store.setWorkflow(input);
    this.announce(store);
    return workflow;
  }

  async clearWorkflow(taskId: string): Promise<void> {
    const store = await this.require();
    store.clearWorkflow(taskId);
    this.announce(store);
  }

  async listWorkflows(): Promise<TaskWorkflow[]> {
    return (await this.require()).listWorkflows();
  }

  /**
   * Replaces one step inside a task's workflow. Every run, retry, skip and
   * cancel goes through here, so two writers cannot lose each other's step: the
   * read, the mutation and the write are one call rather than three.
   */
  async mutateStep(input: {
    taskId: string;
    stepId: string;
    mutate: (step: Step, context: { steps: Step[]; stepIndex: number }) => Step;
  }): Promise<{ workflow: TaskWorkflow; step: Step; steps: Step[]; stepIndex: number }> {
    const store = await this.require();
    const current = store.getWorkflow(input.taskId);
    if (!current) {
      throw new Error(`Task has no workflow: ${input.taskId}`);
    }
    const stepIndex = current.steps.findIndex((step) => step.id === input.stepId);
    if (stepIndex === -1) {
      throw new Error(`Step not found: ${input.stepId}`);
    }
    const nextStep = input.mutate(current.steps[stepIndex], {
      steps: current.steps,
      stepIndex,
    });
    const steps = current.steps.map((step, index) => (index === stepIndex ? nextStep : step));
    const workflow = store.setWorkflow({ taskId: input.taskId, steps });
    this.announce(store);
    return { workflow, step: nextStep, steps, stepIndex };
  }

  // --- Dependencies ---

  async addDependency(input: { taskId: string; dependsOnTaskId: string }): Promise<void> {
    const store = await this.require();
    store.addDependency(input);
    this.announce(store);
  }

  async removeDependency(input: { taskId: string; dependsOnTaskId: string }): Promise<void> {
    const store = await this.require();
    store.removeDependency(input);
    this.announce(store);
  }

  /** Empty when the task is free to be worked; the blockers otherwise. */
  async listUnmetDependencies(taskId: string): Promise<string[]> {
    return (await this.require()).listUnmetDependencies(taskId);
  }

  async createProject(input: CreateTaskProjectInput): Promise<TaskProject> {
    const store = await this.require();
    const project = store.createProject(input);
    this.announce(store);
    return project;
  }

  async createLabel(input: { projectId: string; name: string; color: string }): Promise<string> {
    const store = await this.require();
    const label = store.createLabel(input);
    this.announce(store);
    return label.id;
  }

  async deleteLabel(labelId: string): Promise<void> {
    const store = await this.require();
    store.deleteLabel(labelId);
    this.announce(store);
  }

  async createTask(input: CreateTaskInput): Promise<Task> {
    if (input.parentTaskId && input.status === "done") {
      throw new Error("A subtask cannot be created as Done before it is integrated");
    }
    const store = await this.require();
    const task = store.createTask(input);
    this.emitBoardEventFromStore(store, {
      kind: "task_created",
      taskId: task.id,
      parentTaskId: task.parentTaskId,
      previousStatus: DEFAULT_TASK_STATUS,
      status: task.status,
      cause: `was created in ${task.status}`,
    });
    return task;
  }

  async updateTask(input: UpdateTaskWithEventInput): Promise<Task> {
    if (input.status === "done" && this.completeTaskHandler) {
      return await this.completeThroughGate(input.taskId, input);
    }
    const store = await this.require();
    const written = this.writeTask(store, input);
    if (!written.emittedEvent) {
      this.announce(store);
    }
    return written.task;
  }

  /**
   * Every status change is announced once, from the single place tasks are
   * written. The aggregation rules and the chain triggers hang off this rather
   * than off each caller, which is how the three of them stayed in step.
   */
  setBoardEventListener(listener: BoardEventListener): void {
    this.boardEventListener = listener;
  }

  setFeedDeliveryHandler(
    handler: (input: { agentId: string; text: string }) => Promise<void>,
  ): void {
    this.feedDeliveryHandler = handler;
  }

  private writeTask(
    store: TaskStore,
    input: UpdateTaskWithEventInput,
  ): { task: Task; emittedEvent: boolean } {
    const { boardEvent, ...update } = input;
    const previousStatus = input.status === undefined ? null : store.getTask(input.taskId)?.status;
    const task = store.updateTask(update);
    if (previousStatus && previousStatus !== task.status) {
      this.emitBoardEventFromStore(store, {
        kind: boardEvent?.kind ?? "task_moved",
        taskId: task.id,
        parentTaskId: task.parentTaskId,
        previousStatus,
        status: task.status,
        cause: boardEvent?.cause ?? `moved from ${previousStatus} to ${task.status}`,
        ...(boardEvent?.agentId ? { agentId: boardEvent.agentId } : {}),
        ...(boardEvent?.verdict ? { verdict: boardEvent.verdict } : {}),
      });
      return { task, emittedEvent: true };
    }
    if (boardEvent) {
      this.emitBoardEventFromStore(store, {
        kind: boardEvent.kind,
        taskId: task.id,
        parentTaskId: task.parentTaskId,
        status: task.status,
        cause: boardEvent.cause,
        ...(boardEvent.agentId ? { agentId: boardEvent.agentId } : {}),
        ...(boardEvent.verdict ? { verdict: boardEvent.verdict } : {}),
      });
      return { task, emittedEvent: true };
    }
    return { task, emittedEvent: false };
  }

  async moveTask(input: {
    taskId: string;
    status: TaskStatus;
    beforePosition: number | null;
    afterPosition: number | null;
  }): Promise<Task> {
    if (input.status === "done" && this.completeTaskHandler) {
      const completed = await this.completeThroughGate(input.taskId);
      if (completed.status !== "done") return completed;
    }
    const store = await this.require();
    const previousStatus = store.getTask(input.taskId)?.status;
    const task = store.moveTask(input);
    if (previousStatus && previousStatus !== task.status) {
      this.emitBoardEventFromStore(store, {
        kind: "task_moved",
        taskId: task.id,
        parentTaskId: task.parentTaskId,
        previousStatus,
        status: task.status,
        cause: `moved from ${previousStatus} to ${task.status}`,
      });
      if (task.status === "in_review" && this.reviewEntryHandler) {
        const handle = this.reviewEntryHandler;
        void handle(task.id).catch((error) => {
          this.logger.warn(
            { err: error, taskId: task.id },
            "Could not arm a review for a card moved into review by hand",
          );
        });
      }
    } else {
      this.announce(store);
    }
    return task;
  }

  /** Installs the integration-aware Done transition after the workflow engine
   * exists. Keeping this at the service boundary covers UI drags, RPC and MCP
   * without trusting every caller to remember the delivery gate. */
  setCompleteTaskHandler(handler: (taskId: string) => Promise<Task>): void {
    this.completeTaskHandler = handler;
  }

  /** Arms the configured reviewer when a hand drops a card into review, the
   * same way settling work does on its way in. */
  setReviewEntryHandler(handler: (taskId: string) => Promise<void>): void {
    this.reviewEntryHandler = handler;
  }

  /** Internal terminal write used only after the transition engine has passed
   * the integration gate. Keeping it separate avoids a recursive public Done
   * request and does not open a bypass to RPC or MCP callers. */
  async finalizeTaskDone(taskId: string, boardEvent?: BoardEventCause): Promise<Task> {
    const store = await this.require();
    const written = this.writeTask(store, { taskId, status: "done", boardEvent });
    if (!written.emittedEvent) {
      this.announce(store);
    }
    return written.task;
  }

  private async completeThroughGate(
    taskId: string,
    pendingUpdate?: UpdateTaskInput,
  ): Promise<Task> {
    if (!this.completeTaskHandler) {
      throw new Error("Task completion is unavailable until integration is configured");
    }
    if (pendingUpdate) {
      const { status: _status, ...rest } = pendingUpdate;
      if (Object.keys(rest).some((key) => key !== "taskId")) {
        const store = await this.require();
        store.updateTask(rest);
        this.announce(store);
      }
    }
    return await this.completeTaskHandler(taskId);
  }

  async deleteTask(taskId: string): Promise<void> {
    const store = await this.require();
    store.deleteTask(taskId);
    this.announce(store);
  }

  /**
   * Attaching an agent is how a workflow step, a delegate or a plain chat all
   * reach a task; they differ only in what created the agent.
   *
   * A task whose blockers are still open refuses the attachment. The gate is
   * here rather than in each caller because that is what "claiming" means, and
   * a rule enforced in three places is a rule enforced in two.
   */
  async attachAgent(input: {
    taskId: string;
    agentId: string;
    workspaceId: string;
    presetId?: string | null;
    role?: TaskAgentRole;
    completionOwner?: TaskAgentCompletionOwner;
    /** The corrector the aggregate's own final review sends back is the one
     * worker a task with subtasks may hold. */
    allowAggregate?: boolean;
  }): Promise<void> {
    const store = await this.require();
    this.assertClaimable(store, input.taskId);
    if ((input.role ?? "worker") === "worker" && input.allowAggregate !== true) {
      this.assertLeaf(store, input.taskId);
    }
    store.attachAgent(input);
    const task = store.getTask(input.taskId);
    if (!task) {
      throw new Error(`No task ${input.taskId} to attach an agent to`);
    }
    this.emitBoardEventFromStore(store, {
      kind: "agent_attached",
      taskId: task.id,
      parentTaskId: task.parentTaskId,
      agentId: input.agentId,
      status: task.status,
      cause: `attached agent ${input.agentId} as ${input.role ?? "worker"}`,
    });
    this.moveToWorkingOnStart(store, input.taskId);
  }

  /**
   * An agent landing on a card moves it to Working, unless the card is already
   * somewhere that means something more specific.
   *
   * Without this the board lies while it runs: work started from a card sitting
   * in Backlog would finish and jump straight to Done, having never shown as
   * happening. It is the same rule as settling, read from the other end.
   */
  private moveToWorkingOnStart(store: TaskStore, taskId: string): void {
    const task = store.getTask(taskId);
    if (!task || (task.status !== "backlog" && task.status !== "todo")) {
      return;
    }
    this.writeTask(store, {
      taskId,
      status: "in_progress",
      boardEvent: {
        kind: "task_moved",
        cause: "moved to Working: an agent started on it",
      },
    });
  }

  /** Throws when something the task waits on is neither done nor canceled. */
  assertClaimable(store: TaskStore, taskId: string): void {
    const blockers = store.listUnmetDependencies(taskId);
    if (blockers.length === 0) {
      return;
    }
    const keys = blockers
      .map((blockerId) => {
        const blocker = store.getTask(blockerId);
        return blocker ? `#${blocker.number}` : blockerId;
      })
      .join(", ");
    throw new Error(
      `Task ${taskId} is blocked by ${keys}; finish or cancel them before working it`,
    );
  }

  /**
   * Throws when the task has subtasks. A leaf executes and an aggregate
   * aggregates: a task with children is moved by them, and a worker on it would
   * be delivering work into a branch its own children are still merging into.
   * Reviewers are exempt — the aggregate's final review needs one.
   */
  private assertLeaf(store: TaskStore, taskId: string): void {
    const subtasks = store.countSubtasks(taskId);
    if (subtasks === 0) {
      return;
    }
    const task = store.getTask(taskId);
    const name = task ? `#${task.number}` : taskId;
    throw new Error(
      `Task ${name} has ${subtasks} subtask${subtasks === 1 ? "" : "s"}, so workers attach to its subtasks instead: a task with subtasks is moved by them and holds no workers of its own. Attach to a subtask, or split this work out into one.`,
    );
  }

  /** Check the leaf rule before allocating a worktree or starting an agent.
   * `attachAgent` checks again when the link is committed. */
  async assertTaskExecutable(taskId: string): Promise<void> {
    const store = await this.require();
    this.assertLeaf(store, taskId);
  }

  async listSubtasks(parentTaskId: string): Promise<Task[]> {
    return (await this.require()).listSubtasks(parentTaskId);
  }

  async countSubtasks(parentTaskId: string): Promise<number> {
    return (await this.require()).countSubtasks(parentTaskId);
  }

  /** The tasks waiting on this one. */
  async listDependents(taskId: string): Promise<string[]> {
    return (await this.require()).listDependents(taskId);
  }

  /** The blockers a caller should show before offering to start work. */
  async listBlockers(taskId: string): Promise<Task[]> {
    const store = await this.require();
    return store.listUnmetDependencies(taskId).flatMap((blockerId) => {
      const blocker = store.getTask(blockerId);
      return blocker ? [blocker] : [];
    });
  }

  /** Check dependencies before allocating a worktree or starting an agent.
   * `attachAgent` checks again when the link is committed, closing the race
   * where a blocker is added while those resources are being created. */
  async assertTaskClaimable(taskId: string): Promise<void> {
    const store = await this.require();
    this.assertClaimable(store, taskId);
  }

  /**
   * Removes the links of agents that are gone. This is repair, not a board
   * event: nothing was decided, so the feed stays quiet and only the revision
   * moves, which is what makes the ghost disappear from every open client.
   */
  async pruneAgentLinks(agentIds: readonly string[]): Promise<number> {
    const store = await this.require();
    const removed = store.pruneAgentLinks(agentIds);
    if (removed > 0) {
      this.announce(store);
    }
    return removed;
  }

  async detachAgent(input: { taskId: string; agentId: string }): Promise<void> {
    const store = await this.require();
    store.detachAgent(input);
    this.announce(store);
  }

  // --- Presets ---

  async listPresets(): Promise<TaskPreset[]> {
    return (await this.require()).listPresets();
  }

  async getPreset(presetId: string): Promise<TaskPreset | null> {
    return (await this.require()).getPreset(presetId);
  }

  async createPreset(input: CreateTaskPresetInput): Promise<TaskPreset> {
    const store = await this.require();
    const preset = store.createPreset(input);
    this.announce(store);
    return preset;
  }

  async deletePreset(presetId: string): Promise<void> {
    const store = await this.require();
    store.deletePreset(presetId);
    this.announce(store);
  }

  /** The agents on one card — who a comment on it can be sent to. */
  async listTaskAgentIds(taskId: string): Promise<string[]> {
    return (await this.require()).listTaskAgentIdsByRole(taskId);
  }

  /** The hands that did the work. A review must not come from one of them. */
  async listTaskWorkerIds(taskId: string): Promise<string[]> {
    return (await this.require()).listTaskAgentIdsByRole(taskId, "worker");
  }

  async listBoardAgentIds(projectId: string): Promise<string[]> {
    return (await this.require()).listBoardAgentIds(projectId);
  }

  async listTaskAgents(taskId: string): Promise<TaskAgentLink[]> {
    return (await this.require()).listTaskAgents(taskId);
  }

  async listAgentLinks(): Promise<Array<{ taskId: string } & TaskAgentLink>> {
    return (await this.require()).listAgentLinks();
  }

  async findTasksByAgent(agentId: string): Promise<string[]> {
    return (await this.require()).findTasksByAgent(agentId);
  }

  /**
   * Writes one feed entry. A caller that names a task does not have to know
   * which board it belongs to — the task answers that, and letting the caller
   * pass both would let the two disagree.
   */
  async createComment(input: CreateFeedEntryInput): Promise<TaskComment> {
    return await this.writeFeedEntry(input);
  }

  async writeFeedEntry(input: WriteFeedEntryInput): Promise<TaskComment> {
    const store = await this.require();
    const projectId = await this.resolveFeedProjectId(store, input);
    const { delivery, ...entry } = input;
    const recipients = delivery
      ? this.resolveDeliveryRecipients(store, {
          projectId,
          taskId: input.taskId ?? null,
          delivery,
        })
      : [];
    let comment = this.createFeedEntryFromStore(store, {
      ...entry,
      projectId,
      ...(delivery ? { entryKind: "message", recipients } : {}),
    });
    if (!delivery) {
      return comment;
    }
    const delivered = await Promise.all(
      recipients.map(async (recipient) => {
        try {
          if (!this.feedDeliveryHandler) {
            throw new Error("Agent delivery is unavailable on this host");
          }
          await this.feedDeliveryHandler({ agentId: recipient.agentId, text: delivery.text });
          return Object.assign({}, recipient, { deliveryStatus: "delivered" as const });
        } catch (error) {
          this.logger.warn(
            { err: error, agentId: recipient.agentId, taskId: input.taskId ?? null },
            "Could not deliver a task feed entry",
          );
          return Object.assign({}, recipient, { deliveryStatus: "failed" as const });
        }
      }),
    );
    comment = store.updateCommentRecipients(comment.id, delivered);
    this.announce(store);
    return comment;
  }

  async emitBoardEvent(input: BoardEventInput): Promise<TaskComment> {
    const store = await this.require();
    return this.emitBoardEventFromStore(store, input);
  }

  private emitBoardEventFromStore(store: TaskStore, input: BoardEventInput): TaskComment {
    const task = store.getTask(input.taskId);
    if (!task) {
      throw new Error(`No task ${input.taskId} for board event ${input.kind}`);
    }
    const project = store.getProject(task.projectId);
    if (!project) {
      throw new Error(`No board ${task.projectId} for task ${input.taskId}`);
    }
    const event = toTaskBoardEvent(input);
    const comment = this.createFeedEntryFromStore(store, {
      projectId: project.id,
      taskId: task.id,
      kind: "system",
      authorName: "board",
      agentId: input.agentId,
      body: renderBoardEvent({ project, task, event: input }),
      entryKind: "system_event",
      event,
    });
    if (this.boardEventListener) {
      try {
        this.boardEventListener(event);
      } catch (error) {
        this.logger.warn({ err: error, taskId: task.id }, "A board event listener threw");
      }
    }
    return comment;
  }

  private createFeedEntryFromStore(store: TaskStore, input: CreateTaskCommentInput): TaskComment {
    const comment = store.createComment(input);
    this.announce(store);
    return comment;
  }

  private resolveDeliveryRecipients(
    store: TaskStore,
    input: { projectId: string; taskId: string | null; delivery: FeedDeliveryInput },
  ): NonNullable<TaskComment["recipients"]> {
    const agentIds = [...new Set(input.delivery.agentIds)];
    if (input.delivery.scope === "board") {
      const attached = new Set(store.listBoardAgentIds(input.projectId));
      const missing = agentIds.filter((agentId) => !attached.has(agentId));
      if (missing.length > 0) {
        throw new Error(`Feed recipients are not attached to this board: ${missing.join(", ")}`);
      }
      return agentIds.map((agentId) => ({
        agentId,
        workspaceId: null,
        deliveryStatus: "pending",
      }));
    }
    if (!input.taskId) {
      throw new Error("Task delivery requires a task-scoped feed entry");
    }
    const links = store.listTaskAgents(input.taskId);
    const linksByAgentId = new Map(links.map((link) => [link.agentId, link]));
    const missing = agentIds.filter((agentId) => !linksByAgentId.has(agentId));
    if (missing.length > 0) {
      throw new Error(`Message recipients are not attached to this task: ${missing.join(", ")}`);
    }
    return agentIds.map((agentId) => ({
      agentId,
      workspaceId: linksByAgentId.get(agentId)?.workspaceId ?? null,
      deliveryStatus: "pending",
    }));
  }

  private async resolveFeedProjectId(
    store: TaskStore,
    input: CreateFeedEntryInput,
  ): Promise<string> {
    if (!input.taskId) {
      if (!input.projectId) {
        throw new Error("A feed entry needs either a task or a board");
      }
      return input.projectId;
    }
    const task = store.getTask(input.taskId);
    if (!task) {
      throw new Error(`No task ${input.taskId} to comment on`);
    }
    return task.projectId;
  }

  /** The board's feed, oldest first. */
  async listBoardFeed(input: { projectId: string; limit?: number }): Promise<TaskComment[]> {
    return (await this.require()).listBoardFeed(input);
  }

  async close(): Promise<void> {
    const store = await this.store();
    store?.close();
    this.opening = null;
  }
}
