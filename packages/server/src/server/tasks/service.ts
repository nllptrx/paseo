import type { Task, TaskProject, TaskSnapshot, TaskStatus } from "@getpaseo/protocol/tasks/types";
import type pino from "pino";
import {
  openTaskStore,
  type CreateTaskInput,
  type CreateTaskProjectInput,
  type TaskStore,
  type UpdateTaskInput,
} from "./store.js";

export type TaskRevisionListener = (revision: number) => void;

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
      return await this.opening;
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

  /** Attaching an agent is how a plan step, a delegate or a plain chat all reach
   * a task; they differ only in what created the agent. */
  async attachAgent(input: {
    taskId: string;
    agentId: string;
    workspaceId: string;
    presetId?: string | null;
  }): Promise<void> {
    const store = await this.require();
    store.attachAgent(input);
    this.announce(store);
  }

  async detachAgent(input: { taskId: string; agentId: string }): Promise<void> {
    const store = await this.require();
    store.detachAgent(input);
    this.announce(store);
  }

  async close(): Promise<void> {
    const store = await this.store();
    store?.close();
    this.opening = null;
  }
}
