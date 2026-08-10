import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { Logger } from "pino";
import { z } from "zod";
import { StepSchema, type Step, type TaskWorkflow } from "@getpaseo/protocol/tasks/workflow";

export type TaskAgentRole = "worker" | "reviewer";
export type TaskAgentCompletionOwner = "attachment" | "workflow";
import type {
  Task,
  TaskAgentLink,
  TaskBoardConfig,
  TaskAttachment,
  TaskComment,
  TaskLabel,
  TaskPreset,
  TaskPriority,
  TaskProject,
  TaskSnapshot,
  TaskStatus,
  TaskExecutionPolicy,
  TaskExecutionSpec,
  TaskIntegration,
} from "@getpaseo/protocol/tasks/types";
import {
  TaskExecutionPolicySchema,
  TaskExecutionSpecSchema,
  TaskBoardEventSchema,
  TaskMessageRecipientSchema,
} from "@getpaseo/protocol/tasks/types";
import {
  BlobPathRowSchema,
  CountRowSchema,
  LabelIdRowSchema,
  MaxPositionRowSchema,
  NextNumberRowSchema,
  RevisionRowSchema,
  TaskAgentRowSchema,
  TaskAttachmentRowSchema,
  TaskCommentRowSchema,
  TaskIdRowSchema,
  TaskLabelRowSchema,
  TaskPresetRowSchema,
  TaskDependencyRowSchema,
  TaskProjectRowSchema,
  TaskRowSchema,
  TaskWorkflowRowSchema,
  selectAll,
  selectOne,
  type TaskAttachmentRow,
  type TaskCommentRow,
  type TaskPresetRow,
  type TaskProjectRow,
  type TaskRow,
  type TaskWorkflowRow,
} from "./rows.js";
import { migrateTasksDatabase } from "./schema.js";

/** Gap between neighbours, so an insert between two of them halves the gap
 * instead of renumbering the column. */
const POSITION_STEP = 1024;

/** A feed reads back, not forward: past this the answer is to open the card,
 * not to scroll further. */
const DEFAULT_FEED_LIMIT = 200;

function assertValidDueDate(dueDate: string | null | undefined): void {
  if (dueDate === null || dueDate === undefined) return;
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(dueDate) ? new Date(`${dueDate}T00:00:00.000Z`) : null;
  if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== dueDate) {
    throw new Error("Due date must use YYYY-MM-DD and name a real calendar date");
  }
}

/** Where a captured task lands unless the caller names a status. */
export const DEFAULT_TASK_STATUS: TaskStatus = "backlog";

function generateId(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

export interface CreateTaskProjectInput {
  name: string;
  prefix: string;
  color: string;
  paseoProjectId?: string | null;
}

export interface CreateTaskInput {
  projectId: string;
  title: string;
  description?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  dueDate?: string | null;
  parentTaskId?: string | null;
  labelIds?: readonly string[];
  executionPolicy?: TaskExecutionPolicy;
  executionSpec?: TaskExecutionSpec;
  /** A subtask is chained behind its previous sibling unless this is set. */
  parallel?: boolean;
}

export interface UpdateTaskInput {
  taskId: string;
  title?: string;
  description?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  dueDate?: string | null;
  parentTaskId?: string | null;
  labelIds?: readonly string[];
  /** Internal lifecycle write; clients cannot set this through tasks.update. */
  reviewIteration?: number;
  /** Null returns the task to board/preset defaults. */
  executionPolicy?: TaskExecutionPolicy | null;
  /** Null stops the task starting itself. */
  executionSpec?: TaskExecutionSpec | null;
  /** Internal Git delivery state; clients cannot write it through tasks.update. */
  integration?: TaskIntegration | null;
}

export interface CreateTaskCommentInput {
  projectId: string;
  /** Null for an entry about the board rather than about one card. */
  taskId?: string | null;
  kind: TaskComment["kind"];
  authorName: string;
  agentId?: string | null;
  workspaceId?: string | null;
  body: string;
  entryKind?: TaskComment["entryKind"];
  recipients?: TaskComment["recipients"];
  event?: TaskComment["event"];
}

export interface CreateTaskAttachmentInput {
  taskId?: string | null;
  commentId?: string | null;
  fileName: string;
  mime: string;
  sizeBytes: number;
  blobPath: string;
  isImage: boolean;
}

export interface CreateTaskPresetInput {
  name: string;
  provider: string;
  model?: string | null;
  modeId?: string | null;
  thinkingOptionId?: string | null;
  featureValues?: Record<string, unknown>;
  instructions?: string;
  environmentKind: TaskPreset["environmentKind"];
  baseBranch?: string | null;
}

function resolveIntegrationUpdate(
  current: TaskRow,
  integration: TaskIntegration | null | undefined,
): { branch: string | null; status: TaskIntegration["status"] | null; error: string | null } {
  if (integration === undefined) {
    return {
      branch: current.integration_branch,
      status: current.integration_status,
      error: current.integration_error,
    };
  }
  return {
    branch: integration?.branch ?? null,
    status: integration?.status ?? null,
    error: integration?.error ?? null,
  };
}

function toProject(row: TaskProjectRow): TaskProject {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    color: row.color,
    paseoProjectId: row.paseo_project_id,
    board: {
      reviewEnabled: row.review_enabled === 1,
      reviewOnReject: row.review_on_reject,
      archiveWorkspacesOnDone: row.archive_workspaces_on_done === 1,
      reviewerPresetId: row.reviewer_preset_id,
      maxReviewIterations: row.max_review_iterations,
    },
    createdAt: row.created_at,
  };
}

function toWorkflow(row: TaskWorkflowRow): TaskWorkflow {
  return {
    taskId: row.task_id,
    steps: z.array(StepSchema).parse(JSON.parse(row.steps)),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toAttachment(row: TaskAttachmentRow): TaskAttachment {
  return {
    id: row.id,
    fileName: row.file_name,
    mime: row.mime,
    sizeBytes: row.size_bytes,
    isImage: row.is_image === 1,
    createdAt: row.created_at,
  };
}

function toPreset(row: TaskPresetRow): TaskPreset {
  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    model: row.model,
    modeId: row.mode_id,
    thinkingOptionId: row.thinking_option_id,
    ...(row.feature_values
      ? { featureValues: z.record(z.string(), z.unknown()).parse(JSON.parse(row.feature_values)) }
      : {}),
    instructions: row.instructions,
    environmentKind: row.environment_kind,
    baseBranch: row.base_branch,
    createdAt: row.created_at,
  };
}

/**
 * `node:sqlite` is imported here and nowhere else, and dynamically.
 *
 * A static import runs when the module is loaded, which is daemon start: on a
 * runtime without the built-in driver — Node 22 before 22.13 — that would stop
 * the whole daemon from booting, for every user, over one optional feature.
 * Reaching for it only when the tracker is opened turns that into a tracker that
 * is unavailable and a daemon that runs.
 */
export async function openTaskStore(input: {
  databasePath: string;
  logger: Logger;
  now?: () => Date;
}): Promise<TaskStore> {
  const { DatabaseSync } = await import("node:sqlite");
  if (input.databasePath !== ":memory:") {
    mkdirSync(dirname(input.databasePath), { recursive: true });
  }
  const store = new TaskStore({
    database: new DatabaseSync(input.databasePath),
    logger: input.logger,
    ...(input.now ? { now: input.now } : {}),
  });
  store.markPendingMessageDeliveriesFailed();
  return store;
}

/**
 * The tracker's persistence. Every method is one statement or one transaction —
 * callers never read, merge and write back, so two writers cannot lose each
 * other's work.
 */
export class TaskStore {
  private readonly db: DatabaseSync;
  private readonly now: () => Date;
  private readonly logger: Logger;

  constructor(input: { database: DatabaseSync; logger: Logger; now?: () => Date }) {
    this.db = input.database;
    this.logger = input.logger;
    this.now = input.now ?? (() => new Date());
    migrateTasksDatabase(this.db);
  }

  close(): void {
    this.db.close();
  }

  private timestamp(): string {
    return this.now().toISOString();
  }

  private transaction<T>(run: () => T): T {
    this.db.exec("BEGIN");
    try {
      const result = run();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch (rollbackError) {
        this.logger.error(
          { err: rollbackError },
          "Failed to roll back a tracker transaction after an error",
        );
      }
      throw error;
    }
  }

  getRevision(): number {
    const row = selectOne(
      this.db.prepare("SELECT revision FROM task_revision WHERE id = 1"),
      RevisionRowSchema,
      "task_revision",
    );
    return row?.revision ?? 0;
  }

  // --- Projects ---

  createProject(input: CreateTaskProjectInput): TaskProject {
    if (input.paseoProjectId) {
      const existing = this.findProjectByPaseoProjectId(input.paseoProjectId);
      if (existing) {
        return existing;
      }
    }
    const id = generateId("tprj");
    const prefix = input.prefix.trim().toUpperCase();
    const name = input.name.trim();
    const duplicate = selectOne(
      this.db.prepare("SELECT * FROM task_projects WHERE prefix = ? COLLATE NOCASE"),
      TaskProjectRowSchema,
      "task_projects",
      [prefix],
    );
    if (duplicate) {
      throw new Error(`A task project with prefix ${prefix} already exists`);
    }
    const createdAt = this.timestamp();
    this.db
      .prepare(
        `INSERT INTO task_projects (id, name, prefix, color, paseo_project_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, name, prefix, input.color, input.paseoProjectId ?? null, createdAt);
    return {
      id,
      name,
      prefix,
      color: input.color,
      paseoProjectId: input.paseoProjectId ?? null,
      board: {
        reviewEnabled: false,
        reviewOnReject: "in_progress",
        archiveWorkspacesOnDone: false,
        reviewerPresetId: null,
        maxReviewIterations: 3,
      },
      createdAt,
    };
  }

  listProjects(): TaskProject[] {
    return selectAll(
      this.db.prepare("SELECT * FROM task_projects ORDER BY name COLLATE NOCASE, id"),
      TaskProjectRowSchema,
      "task_projects",
    ).map(toProject);
  }

  getProject(projectId: string): TaskProject | null {
    const row = selectOne(
      this.db.prepare("SELECT * FROM task_projects WHERE id = ?"),
      TaskProjectRowSchema,
      "task_projects",
      [projectId],
    );
    return row ? toProject(row) : null;
  }

  findProjectByPaseoProjectId(paseoProjectId: string): TaskProject | null {
    const row = selectOne(
      this.db.prepare("SELECT * FROM task_projects WHERE paseo_project_id = ? ORDER BY id LIMIT 1"),
      TaskProjectRowSchema,
      "task_projects",
      [paseoProjectId],
    );
    return row ? toProject(row) : null;
  }

  configureBoard(input: {
    projectId: string;
    reviewEnabled?: boolean;
    reviewOnReject?: TaskBoardConfig["reviewOnReject"];
    archiveWorkspacesOnDone?: boolean;
    reviewerPresetId?: string | null;
    maxReviewIterations?: number;
  }): TaskProject {
    const current = this.getProject(input.projectId);
    if (!current) {
      throw new Error(`Task project not found: ${input.projectId}`);
    }
    const board = current.board ?? {
      reviewEnabled: false,
      reviewOnReject: "in_progress" as const,
      archiveWorkspacesOnDone: false,
      reviewerPresetId: null,
      maxReviewIterations: 3,
    };
    const next: TaskBoardConfig = {
      reviewEnabled: input.reviewEnabled ?? board.reviewEnabled,
      reviewOnReject: input.reviewOnReject ?? board.reviewOnReject,
      archiveWorkspacesOnDone: input.archiveWorkspacesOnDone ?? board.archiveWorkspacesOnDone,
      reviewerPresetId:
        input.reviewerPresetId !== undefined
          ? input.reviewerPresetId
          : (board.reviewerPresetId ?? null),
      maxReviewIterations: input.maxReviewIterations ?? board.maxReviewIterations ?? 3,
    };
    this.db
      .prepare(
        `UPDATE task_projects
         SET review_enabled = ?, review_on_reject = ?, archive_workspaces_on_done = ?,
             reviewer_preset_id = ?, max_review_iterations = ?
         WHERE id = ?`,
      )
      .run(
        next.reviewEnabled ? 1 : 0,
        next.reviewOnReject,
        next.archiveWorkspacesOnDone ? 1 : 0,
        next.reviewerPresetId ?? null,
        next.maxReviewIterations ?? 3,
        input.projectId,
      );
    return { ...current, board: next };
  }

  // --- Labels ---

  createLabel(input: { projectId: string; name: string; color: string }): TaskLabel {
    const id = generateId("tlbl");
    const name = input.name.trim();
    this.db
      .prepare("INSERT INTO task_labels (id, project_id, name, color) VALUES (?, ?, ?, ?)")
      .run(id, input.projectId, name, input.color);
    return { id, projectId: input.projectId, name, color: input.color };
  }

  listLabels(): TaskLabel[] {
    return selectAll(
      this.db.prepare("SELECT * FROM task_labels ORDER BY name COLLATE NOCASE, id"),
      TaskLabelRowSchema,
      "task_labels",
    ).map((row) => ({
      id: row.id,
      projectId: row.project_id,
      name: row.name,
      color: row.color,
    }));
  }

  deleteLabel(labelId: string): void {
    this.db.prepare("DELETE FROM task_labels WHERE id = ?").run(labelId);
  }

  // --- Tasks ---

  createTask(input: CreateTaskInput): Task {
    assertValidDueDate(input.dueDate);
    return this.transaction(() => {
      const projectRow = selectOne(
        this.db.prepare("SELECT next_task_number FROM task_projects WHERE id = ?"),
        NextNumberRowSchema,
        "task_projects",
        [input.projectId],
      );
      if (!projectRow) {
        throw new Error(`Unknown task project ${input.projectId}`);
      }
      const number = projectRow.next_task_number;
      this.db
        .prepare("UPDATE task_projects SET next_task_number = ? WHERE id = ?")
        .run(number + 1, input.projectId);

      const status = input.status ?? DEFAULT_TASK_STATUS;
      const id = generateId("task");
      const timestamp = this.timestamp();
      if (input.parentTaskId) {
        this.assertValidParent({
          taskId: id,
          projectId: input.projectId,
          parentTaskId: input.parentTaskId,
        });
      }

      this.db
        .prepare(
          `INSERT INTO tasks (
             id, project_id, number, title, description, status, priority,
             due_date, parent_task_id, position, created_at, updated_at, execution_policy,
             execution_spec
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.projectId,
          number,
          input.title.trim(),
          input.description ?? "",
          status,
          input.priority ?? "none",
          input.dueDate ?? null,
          input.parentTaskId ?? null,
          this.nextPosition(input.projectId, status),
          timestamp,
          timestamp,
          input.executionPolicy ? JSON.stringify(input.executionPolicy) : null,
          input.executionSpec ? JSON.stringify(input.executionSpec) : null,
        );

      this.replaceLabels(id, input.labelIds ?? []);
      if (input.parentTaskId && input.parallel !== true) {
        this.chainBehindPreviousSibling({ taskId: id, parentTaskId: input.parentTaskId });
      }
      return this.requireTask(id);
    });
  }

  /**
   * A new subtask waits on the sibling created before it, so a decomposition is
   * a chain unless somebody asks for parallel work. The order becomes ordinary
   * dependency edges: readiness stays inspectable and every dispatch path
   * honours it without a second scheduler-specific blocking model.
   *
   * Edges already stored are never rewritten — a chain a person reordered by
   * hand is the chain they meant.
   */
  private chainBehindPreviousSibling(input: { taskId: string; parentTaskId: string }): void {
    const siblings = selectAll(
      this.db.prepare(
        `SELECT id AS task_id FROM tasks
         WHERE parent_task_id = ? AND id <> ?
         ORDER BY position, created_at, id`,
      ),
      TaskIdRowSchema,
      "tasks",
      [input.parentTaskId, input.taskId],
    );
    const previous = siblings.at(-1);
    if (!previous) {
      return;
    }
    this.db
      .prepare(
        "INSERT OR IGNORE INTO task_dependencies (task_id, depends_on_task_id) VALUES (?, ?)",
      )
      .run(input.taskId, previous.task_id);
  }

  /** Hierarchy stays inside one board and cannot fold back onto itself. */
  private assertValidParent(input: {
    taskId: string;
    projectId: string;
    parentTaskId: string;
  }): void {
    let candidate: string | null = input.parentTaskId;
    const visited = new Set<string>();
    while (candidate) {
      if (candidate === input.taskId || visited.has(candidate)) {
        throw new Error("A task cannot be its own ancestor");
      }
      visited.add(candidate);
      const row = this.requireTaskRow(candidate);
      if (row.project_id !== input.projectId) {
        throw new Error("A task and its parent must belong to the same project");
      }
      candidate = row.parent_task_id;
    }
  }

  private nextPosition(projectId: string, status: TaskStatus): number {
    const row = selectOne(
      this.db.prepare("SELECT MAX(position) AS top FROM tasks WHERE project_id = ? AND status = ?"),
      MaxPositionRowSchema,
      "tasks",
      [projectId, status],
    );
    return row?.top === null || row?.top === undefined ? POSITION_STEP : row.top + POSITION_STEP;
  }

  private replaceLabels(taskId: string, labelIds: readonly string[]): void {
    this.db.prepare("DELETE FROM task_label_links WHERE task_id = ?").run(taskId);
    const insert = this.db.prepare(
      "INSERT OR IGNORE INTO task_label_links (task_id, label_id) VALUES (?, ?)",
    );
    for (const labelId of labelIds) {
      insert.run(taskId, labelId);
    }
  }

  updateTask(input: UpdateTaskInput): Task {
    assertValidDueDate(input.dueDate);
    return this.transaction(() => {
      const current = this.requireTaskRow(input.taskId);
      // Moving between statuses lands the task at the end of its new column;
      // an explicit drop uses moveTask instead.
      const status = input.status ?? current.status;
      const position =
        status === current.status
          ? current.position
          : this.nextPosition(current.project_id, status);
      const reviewIteration =
        input.reviewIteration ??
        (status === "in_progress" && current.status !== "in_progress"
          ? 0
          : current.review_iteration);
      const parentTaskId =
        input.parentTaskId === undefined ? current.parent_task_id : input.parentTaskId;
      if (parentTaskId) {
        this.assertValidParent({
          taskId: input.taskId,
          projectId: current.project_id,
          parentTaskId,
        });
      }
      let executionPolicy = current.execution_policy;
      if (input.executionPolicy === null) {
        executionPolicy = null;
      } else if (input.executionPolicy !== undefined) {
        executionPolicy = JSON.stringify(input.executionPolicy);
      }
      let executionSpec = current.execution_spec;
      if (input.executionSpec === null) {
        executionSpec = null;
      } else if (input.executionSpec !== undefined) {
        executionSpec = JSON.stringify(input.executionSpec);
      }
      const integration = resolveIntegrationUpdate(current, input.integration);

      this.db
        .prepare(
          `UPDATE tasks SET
             title = ?, description = ?, status = ?, priority = ?,
             due_date = ?, parent_task_id = ?, position = ?, updated_at = ?, review_iteration = ?,
             execution_policy = ?, execution_spec = ?, integration_branch = ?,
             integration_status = ?, integration_error = ?
           WHERE id = ?`,
        )
        .run(
          input.title?.trim() ?? current.title,
          input.description ?? current.description,
          status,
          input.priority ?? current.priority,
          input.dueDate === undefined ? current.due_date : input.dueDate,
          parentTaskId,
          position,
          this.timestamp(),
          reviewIteration,
          executionPolicy,
          executionSpec,
          integration.branch,
          integration.status,
          integration.error,
          input.taskId,
        );

      if (input.labelIds) {
        this.replaceLabels(input.taskId, input.labelIds);
      }
      return this.requireTask(input.taskId);
    });
  }

  /** A drop: the task takes a position between the two it landed between. */
  moveTask(input: {
    taskId: string;
    status: TaskStatus;
    beforePosition: number | null;
    afterPosition: number | null;
  }): Task {
    const { beforePosition, afterPosition } = input;
    let position: number;
    if (beforePosition === null && afterPosition === null) {
      position = POSITION_STEP;
    } else if (beforePosition === null) {
      position = (afterPosition as number) - POSITION_STEP;
    } else if (afterPosition === null) {
      position = beforePosition + POSITION_STEP;
    } else {
      position = (beforePosition + afterPosition) / 2;
    }
    this.db
      .prepare("UPDATE tasks SET status = ?, position = ?, updated_at = ? WHERE id = ?")
      .run(input.status, position, this.timestamp(), input.taskId);
    return this.requireTask(input.taskId);
  }

  deleteTask(taskId: string): void {
    this.db.prepare("DELETE FROM tasks WHERE id = ?").run(taskId);
  }

  getTask(taskId: string): Task | null {
    const row = this.findTaskRow(taskId);
    return row ? this.toTask(row) : null;
  }

  private findTaskRow(taskId: string): TaskRow | null {
    return selectOne(this.db.prepare("SELECT * FROM tasks WHERE id = ?"), TaskRowSchema, "tasks", [
      taskId,
    ]);
  }

  private requireTaskRow(taskId: string): TaskRow {
    const row = this.findTaskRow(taskId);
    if (!row) {
      throw new Error(`Unknown task ${taskId}`);
    }
    return row;
  }

  private requireTask(taskId: string): Task {
    return this.toTask(this.requireTaskRow(taskId));
  }

  private toTask(row: TaskRow): Task {
    const labelIds = selectAll(
      this.db.prepare("SELECT label_id FROM task_label_links WHERE task_id = ?"),
      LabelIdRowSchema,
      "task_label_links",
      [row.id],
    ).map((entry) => entry.label_id);
    const commentCount =
      selectOne(
        this.db.prepare("SELECT COUNT(*) AS total FROM task_comments WHERE task_id = ?"),
        CountRowSchema,
        "task_comments",
        [row.id],
      )?.total ?? 0;

    return {
      id: row.id,
      projectId: row.project_id,
      number: row.number,
      title: row.title,
      description: row.description,
      status: row.status,
      priority: row.priority,
      dueDate: row.due_date,
      parentTaskId: row.parent_task_id,
      position: row.position,
      labelIds,
      agents: this.listTaskAgents(row.id),
      attachments: this.listAttachments({ taskId: row.id }),
      commentCount,
      reviewIteration: row.review_iteration,
      ...(row.execution_policy
        ? { executionPolicy: TaskExecutionPolicySchema.parse(JSON.parse(row.execution_policy)) }
        : {}),
      ...(row.execution_spec
        ? { executionSpec: TaskExecutionSpecSchema.parse(JSON.parse(row.execution_spec)) }
        : {}),
      ...(row.integration_branch && row.integration_status
        ? {
            integration: {
              branch: row.integration_branch,
              status: row.integration_status,
              error: row.integration_error,
            },
          }
        : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /** The task's direct children, in board order. A task that has any is an
   * aggregate: it is moved by them and holds no workers of its own. */
  listSubtasks(parentTaskId: string): Task[] {
    return selectAll(
      this.db.prepare(
        "SELECT * FROM tasks WHERE parent_task_id = ? ORDER BY position, created_at, id",
      ),
      TaskRowSchema,
      "tasks",
      [parentTaskId],
    ).map((row) => this.toTask(row));
  }

  countSubtasks(parentTaskId: string): number {
    return (
      selectOne(
        this.db.prepare("SELECT COUNT(*) AS total FROM tasks WHERE parent_task_id = ?"),
        CountRowSchema,
        "tasks",
        [parentTaskId],
      )?.total ?? 0
    );
  }

  /** The tasks waiting on this one — who a settle may have just unblocked. */
  listDependents(taskId: string): string[] {
    return selectAll(
      this.db.prepare(
        "SELECT task_id FROM task_dependencies WHERE depends_on_task_id = ? ORDER BY task_id",
      ),
      TaskIdRowSchema,
      "task_dependencies",
      [taskId],
    ).map((row) => row.task_id);
  }

  /** One read for a whole view, stamped with the revision it saw. */
  snapshot(): TaskSnapshot {
    const tasks = selectAll(
      this.db.prepare("SELECT * FROM tasks ORDER BY project_id, status, position, id"),
      TaskRowSchema,
      "tasks",
    ).map((row) => this.toTask(row));
    return {
      revision: this.getRevision(),
      projects: this.listProjects(),
      labels: this.listLabels(),
      tasks,
      workflows: this.listWorkflows(),
      dependencies: this.listDependencies(),
    };
  }

  // --- Workflows ---

  getWorkflow(taskId: string): TaskWorkflow | null {
    const row = selectOne(
      this.db.prepare("SELECT * FROM task_workflows WHERE task_id = ?"),
      TaskWorkflowRowSchema,
      "task_workflows",
      [taskId],
    );
    return row ? toWorkflow(row) : null;
  }

  listWorkflows(): TaskWorkflow[] {
    const workflows: TaskWorkflow[] = [];
    const rows = selectAll(
      this.db.prepare("SELECT * FROM task_workflows ORDER BY task_id"),
      TaskWorkflowRowSchema,
      "task_workflows",
    );
    for (const row of rows) {
      try {
        workflows.push(toWorkflow(row));
      } catch (error) {
        // One card's stored steps being unreadable is that card's problem. It
        // must not take the board's other workflows down with it, and this list
        // is what recovery reads at boot.
        this.logger.error(
          { err: error, taskId: row.task_id },
          "Skipped a workflow whose stored steps could not be read",
        );
      }
    }
    return workflows;
  }

  setWorkflow(input: { taskId: string; steps: readonly Step[] }): TaskWorkflow {
    const now = this.timestamp();
    const serialized = JSON.stringify(input.steps);
    this.db
      .prepare(
        `INSERT INTO task_workflows (task_id, steps, created_at, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (task_id) DO UPDATE SET steps = excluded.steps, updated_at = excluded.updated_at`,
      )
      .run(input.taskId, serialized, now, now);
    const stored = this.getWorkflow(input.taskId);
    if (!stored) {
      throw new Error(`Workflow write did not persist for task: ${input.taskId}`);
    }
    return stored;
  }

  clearWorkflow(taskId: string): void {
    this.db.prepare("DELETE FROM task_workflows WHERE task_id = ?").run(taskId);
  }

  // --- Dependencies ---

  addDependency(input: { taskId: string; dependsOnTaskId: string }): void {
    const task = this.requireTaskRow(input.taskId);
    const dependency = this.requireTaskRow(input.dependsOnTaskId);
    if (task.id === dependency.id) {
      throw new Error("A task cannot depend on itself");
    }
    if (task.project_id !== dependency.project_id) {
      throw new Error("A task and its dependencies must belong to the same project");
    }
    const createsCycle = selectOne(
      this.db.prepare(
        `WITH RECURSIVE reachable(task_id) AS (
           SELECT depends_on_task_id
           FROM task_dependencies
           WHERE task_id = ?
           UNION
           SELECT dependency.depends_on_task_id
           FROM task_dependencies dependency
           JOIN reachable ON dependency.task_id = reachable.task_id
         )
         SELECT 1 AS found
         FROM reachable
         WHERE task_id = ?
         LIMIT 1`,
      ),
      z.object({ found: z.literal(1) }),
      "task_dependencies",
      [input.dependsOnTaskId, input.taskId],
    );
    if (createsCycle) {
      throw new Error("A task dependency cannot create a cycle");
    }
    this.db
      .prepare(
        `INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES (?, ?)
         ON CONFLICT DO NOTHING`,
      )
      .run(input.taskId, input.dependsOnTaskId);
  }

  removeDependency(input: { taskId: string; dependsOnTaskId: string }): void {
    this.db
      .prepare("DELETE FROM task_dependencies WHERE task_id = ? AND depends_on_task_id = ?")
      .run(input.taskId, input.dependsOnTaskId);
  }

  listDependencies(): Array<{ taskId: string; dependsOnTaskId: string }> {
    return selectAll(
      this.db.prepare("SELECT * FROM task_dependencies ORDER BY task_id, depends_on_task_id"),
      TaskDependencyRowSchema,
      "task_dependencies",
    ).map((row) => ({ taskId: row.task_id, dependsOnTaskId: row.depends_on_task_id }));
  }

  /** The tasks blocking this one that have not reached a terminal status. */
  listUnmetDependencies(taskId: string): string[] {
    return selectAll(
      this.db.prepare(
        `SELECT d.depends_on_task_id AS task_id
         FROM task_dependencies d
         JOIN tasks t ON t.id = d.depends_on_task_id
         WHERE d.task_id = ? AND t.status NOT IN ('done', 'canceled')
         ORDER BY t.id`,
      ),
      TaskIdRowSchema,
      "task_dependencies",
      [taskId],
    ).map((row) => row.task_id);
  }

  // --- Agents ---

  attachAgent(input: {
    taskId: string;
    agentId: string;
    workspaceId: string;
    presetId?: string | null;
    role?: TaskAgentRole;
    completionOwner?: TaskAgentCompletionOwner;
  }): void {
    this.db
      .prepare(
        `INSERT INTO task_agents (
           task_id, agent_id, workspace_id, preset_id, role, completion_owner, attached_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (task_id, agent_id) DO UPDATE SET
           workspace_id = excluded.workspace_id,
           preset_id = excluded.preset_id,
           role = excluded.role,
           completion_owner = excluded.completion_owner`,
      )
      .run(
        input.taskId,
        input.agentId,
        input.workspaceId,
        input.presetId ?? null,
        input.role ?? "worker",
        input.completionOwner ?? "attachment",
        this.timestamp(),
      );
  }

  detachAgent(input: { taskId: string; agentId: string }): void {
    this.db
      .prepare("DELETE FROM task_agents WHERE task_id = ? AND agent_id = ?")
      .run(input.taskId, input.agentId);
  }

  /**
   * Drops every link the named agents hold, on any task and in any role. A card
   * must never show an agent that no longer exists, and the link is the only
   * place membership is stored, so removing it is the whole repair.
   */
  pruneAgentLinks(agentIds: readonly string[]): number {
    if (agentIds.length === 0) {
      return 0;
    }
    const statement = this.db.prepare("DELETE FROM task_agents WHERE agent_id = ?");
    let removed = 0;
    for (const agentId of agentIds) {
      removed += Number(statement.run(agentId).changes);
    }
    return removed;
  }

  listTaskAgents(taskId: string): TaskAgentLink[] {
    return selectAll(
      this.db.prepare("SELECT * FROM task_agents WHERE task_id = ? ORDER BY attached_at, agent_id"),
      TaskAgentRowSchema,
      "task_agents",
      [taskId],
    ).map((row) => ({
      agentId: row.agent_id,
      workspaceId: row.workspace_id,
      presetId: row.preset_id,
      role: row.role,
      completionOwner: row.completion_owner,
      attachedAt: row.attached_at,
    }));
  }

  /** Every attachment on the host, for re-arming completion observers at boot. */
  /** Agent ids on a card, narrowed to a role when one is asked for. */
  listTaskAgentIdsByRole(taskId: string, role?: TaskAgentRole): string[] {
    return this.listTaskAgents(taskId)
      .filter((link) => (role ? (link.role ?? "worker") === role : true))
      .map((link) => link.agentId);
  }

  /** Every agent working a card on this board — who a feed mention can reach. */
  listBoardAgentIds(projectId: string): string[] {
    const rows = selectAll(
      this.db.prepare(
        `SELECT a.* FROM task_agents a
         JOIN tasks t ON t.id = a.task_id
         WHERE t.project_id = ?
         ORDER BY a.attached_at, a.agent_id`,
      ),
      TaskAgentRowSchema,
      "task_agents",
      [projectId],
    );
    return [...new Set(rows.map((row) => row.agent_id))];
  }

  listAgentLinks(): Array<{ taskId: string } & TaskAgentLink> {
    return selectAll(
      this.db.prepare("SELECT * FROM task_agents ORDER BY attached_at, agent_id"),
      TaskAgentRowSchema,
      "task_agents",
    ).map((row) => ({
      taskId: row.task_id,
      agentId: row.agent_id,
      workspaceId: row.workspace_id,
      presetId: row.preset_id,
      role: row.role,
      completionOwner: row.completion_owner,
      attachedAt: row.attached_at,
    }));
  }

  findTasksByAgent(agentId: string): string[] {
    return selectAll(
      this.db.prepare("SELECT task_id FROM task_agents WHERE agent_id = ?"),
      TaskIdRowSchema,
      "task_agents",
      [agentId],
    ).map((row) => row.task_id);
  }

  // --- Comments ---

  createComment(input: CreateTaskCommentInput): TaskComment {
    const id = generateId("tcmt");
    const createdAt = this.timestamp();
    let entryKind = input.entryKind;
    if (entryKind === undefined) {
      entryKind = input.kind === "agent" ? "agent_update" : "note";
      if (input.kind === "system") {
        entryKind = "system_event";
      }
    }
    this.db
      .prepare(
        `INSERT INTO task_comments (
           id, project_id, task_id, kind, author_name, agent_id, workspace_id, body,
           entry_kind, recipients_json, event_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.projectId,
        input.taskId ?? null,
        input.kind,
        input.authorName,
        input.agentId ?? null,
        input.workspaceId ?? null,
        input.body,
        entryKind,
        input.recipients ? JSON.stringify(input.recipients) : null,
        input.event ? JSON.stringify(input.event) : null,
        createdAt,
      );
    return {
      id,
      projectId: input.projectId,
      taskId: input.taskId ?? null,
      kind: input.kind,
      authorName: input.authorName,
      agentId: input.agentId ?? null,
      workspaceId: input.workspaceId ?? null,
      body: input.body,
      attachments: [],
      createdAt,
      entryKind,
      ...(input.recipients ? { recipients: [...input.recipients] } : {}),
      ...(input.event ? { event: input.event } : {}),
    };
  }

  updateCommentRecipients(
    commentId: string,
    recipients: NonNullable<TaskComment["recipients"]>,
  ): TaskComment {
    this.db
      .prepare("UPDATE task_comments SET recipients_json = ? WHERE id = ?")
      .run(JSON.stringify(recipients), commentId);
    const row = selectOne(
      this.db.prepare("SELECT * FROM task_comments WHERE id = ?"),
      TaskCommentRowSchema,
      "task_comments",
      [commentId],
    );
    if (!row) throw new Error(`No feed entry ${commentId}`);
    return this.toComment(row);
  }

  markPendingMessageDeliveriesFailed(): number {
    const rows = selectAll(
      this.db.prepare(
        "SELECT * FROM task_comments WHERE entry_kind = 'message' AND recipients_json IS NOT NULL",
      ),
      TaskCommentRowSchema,
      "task_comments",
    );
    let updated = 0;
    for (const row of rows) {
      const recipients = TaskMessageRecipientSchema.array().parse(JSON.parse(row.recipients_json!));
      if (!recipients.some((recipient) => recipient.deliveryStatus === "pending")) {
        continue;
      }
      this.updateCommentRecipients(
        row.id,
        recipients.map((recipient) =>
          Object.assign({}, recipient, {
            deliveryStatus:
              recipient.deliveryStatus === "pending" ? "failed" : recipient.deliveryStatus,
          }),
        ),
      );
      updated += 1;
    }
    return updated;
  }

  /**
   * The board's whole feed, oldest first: every card's comments plus the
   * entries that belong to the board itself, in one order.
   *
   * The tie-break is the rowid rather than the id. Two entries written in the
   * same millisecond are common — a move and the note about it — and ids are
   * random hex, so ordering by them would shuffle a cause after its effect.
   */
  listBoardFeed(input: { projectId: string; limit?: number }): TaskComment[] {
    const limit = Math.min(input.limit ?? DEFAULT_FEED_LIMIT, DEFAULT_FEED_LIMIT);
    const rows = selectAll(
      this.db.prepare(
        `SELECT * FROM task_comments
         WHERE project_id = ?
         ORDER BY created_at DESC, rowid DESC
         LIMIT ?`,
      ),
      TaskCommentRowSchema,
      "task_comments",
      [input.projectId, limit],
    );
    return rows.toReversed().map((row) => this.toComment(row));
  }

  listComments(taskId: string): TaskComment[] {
    return selectAll(
      this.db.prepare("SELECT * FROM task_comments WHERE task_id = ? ORDER BY created_at, rowid"),
      TaskCommentRowSchema,
      "task_comments",
      [taskId],
    ).map((row) => this.toComment(row));
  }

  private toComment(row: TaskCommentRow): TaskComment {
    const recipients = row.recipients_json
      ? TaskMessageRecipientSchema.array().parse(JSON.parse(row.recipients_json))
      : undefined;
    const event = row.event_json
      ? TaskBoardEventSchema.parse(JSON.parse(row.event_json))
      : undefined;
    return {
      id: row.id,
      projectId: row.project_id,
      taskId: row.task_id,
      kind: row.kind,
      authorName: row.author_name,
      agentId: row.agent_id,
      workspaceId: row.workspace_id,
      body: row.body,
      attachments: this.listAttachments({ commentId: row.id }),
      createdAt: row.created_at,
      ...(row.entry_kind ? { entryKind: row.entry_kind } : {}),
      ...(recipients ? { recipients } : {}),
      ...(event ? { event } : {}),
    };
  }

  deleteComment(commentId: string): void {
    this.db.prepare("DELETE FROM task_comments WHERE id = ?").run(commentId);
  }

  // --- Attachments ---

  createAttachment(input: CreateTaskAttachmentInput): TaskAttachment {
    const id = generateId("tatt");
    const createdAt = this.timestamp();
    this.db
      .prepare(
        `INSERT INTO task_attachments (
           id, task_id, comment_id, file_name, mime, size_bytes, blob_path, is_image, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.taskId ?? null,
        input.commentId ?? null,
        input.fileName,
        input.mime,
        input.sizeBytes,
        input.blobPath,
        input.isImage ? 1 : 0,
        createdAt,
      );
    return {
      id,
      fileName: input.fileName,
      mime: input.mime,
      sizeBytes: input.sizeBytes,
      isImage: input.isImage,
      createdAt,
    };
  }

  listAttachments(scope: { taskId?: string; commentId?: string }): TaskAttachment[] {
    const statement = scope.taskId
      ? this.db.prepare("SELECT * FROM task_attachments WHERE task_id = ? ORDER BY created_at, id")
      : this.db.prepare(
          "SELECT * FROM task_attachments WHERE comment_id = ? ORDER BY created_at, id",
        );
    return selectAll(statement, TaskAttachmentRowSchema, "task_attachments", [
      scope.taskId ?? scope.commentId ?? "",
    ]).map(toAttachment);
  }

  getAttachmentBlobPath(attachmentId: string): string | null {
    return (
      selectOne(
        this.db.prepare("SELECT blob_path FROM task_attachments WHERE id = ?"),
        BlobPathRowSchema,
        "task_attachments",
        [attachmentId],
      )?.blob_path ?? null
    );
  }

  // --- Presets ---

  createPreset(input: CreateTaskPresetInput): TaskPreset {
    const id = generateId("tpst");
    const name = input.name.trim();
    const duplicate = selectOne(
      this.db.prepare("SELECT id FROM task_presets WHERE name = ? COLLATE NOCASE"),
      z.object({ id: z.string() }),
      "task_presets",
      [name],
    );
    if (duplicate) {
      throw new Error(`A task preset named "${name}" already exists`);
    }
    this.db
      .prepare(
        `INSERT INTO task_presets (
           id, name, provider, model, mode_id, thinking_option_id, feature_values,
           instructions, environment_kind, base_branch, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        name,
        input.provider,
        input.model ?? null,
        input.modeId ?? null,
        input.thinkingOptionId ?? null,
        input.featureValues ? JSON.stringify(input.featureValues) : null,
        input.instructions ?? "",
        input.environmentKind,
        input.baseBranch ?? null,
        this.timestamp(),
      );
    const preset = this.getPreset(id);
    if (!preset) {
      throw new Error(`Preset ${id} vanished immediately after insert`);
    }
    return preset;
  }

  listPresets(): TaskPreset[] {
    return selectAll(
      this.db.prepare("SELECT * FROM task_presets ORDER BY name COLLATE NOCASE, id"),
      TaskPresetRowSchema,
      "task_presets",
    ).map(toPreset);
  }

  getPreset(presetId: string): TaskPreset | null {
    const row = selectOne(
      this.db.prepare("SELECT * FROM task_presets WHERE id = ?"),
      TaskPresetRowSchema,
      "task_presets",
      [presetId],
    );
    return row ? toPreset(row) : null;
  }

  deletePreset(presetId: string): void {
    this.db.prepare("DELETE FROM task_presets WHERE id = ?").run(presetId);
  }
}
