import type {
  Task,
  TaskAgentLink,
  TaskBoardConfig,
  TaskComment,
  TaskPreset,
  TaskProject,
  TaskSnapshot,
  TaskStatus,
} from "@getpaseo/protocol/tasks/types";
import type { Step, TaskWorkflow } from "@getpaseo/protocol/tasks/workflow";
import type pino from "pino";
import {
  openTaskStore,
  type CreateTaskCommentInput,
  type CreateTaskInput,
  type CreateTaskPresetInput,
  type CreateTaskProjectInput,
  type TaskStore,
  type UpdateTaskInput,
} from "./store.js";

export type TaskRevisionListener = (revision: number) => void;

/** Either a task (the board comes from it) or a board directly. */
export type CreateFeedEntryInput = Omit<CreateTaskCommentInput, "projectId"> & {
  projectId?: string;
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
      this.opening = openTaskStore({ databasePath: this.databasePath });
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

  async createTask(input: CreateTaskInput): Promise<Task> {
    const store = await this.require();
    const task = store.createTask(input);
    this.announce(store);
    return task;
  }

  async updateTask(input: UpdateTaskInput): Promise<Task> {
    const store = await this.require();
    const task = store.updateTask(input);
    this.announce(store);
    return task;
  }

  async moveTask(input: {
    taskId: string;
    status: TaskStatus;
    beforePosition: number | null;
    afterPosition: number | null;
  }): Promise<Task> {
    const store = await this.require();
    const task = store.moveTask(input);
    this.announce(store);
    return task;
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
  }): Promise<void> {
    const store = await this.require();
    this.assertClaimable(store, input.taskId);
    store.attachAgent(input);
    this.announce(store);
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

  /** The blockers a caller should show before offering to start work. */
  async listBlockers(taskId: string): Promise<Task[]> {
    const store = await this.require();
    return store.listUnmetDependencies(taskId).flatMap((blockerId) => {
      const blocker = store.getTask(blockerId);
      return blocker ? [blocker] : [];
    });
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

  async listBoardAgentIds(projectId: string): Promise<string[]> {
    return (await this.require()).listBoardAgentIds(projectId);
  }

  async listTaskAgents(taskId: string): Promise<TaskAgentLink[]> {
    return (await this.require()).listTaskAgents(taskId);
  }

  async listAgentLinks(): Promise<Array<{ taskId: string; agentId: string; workspaceId: string }>> {
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
    const store = await this.require();
    const projectId = await this.resolveFeedProjectId(store, input);
    const comment = store.createComment({ ...input, projectId });
    this.announce(store);
    return comment;
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
