import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  Task,
  TaskAgentLink,
  TaskAttachment,
  TaskComment,
  TaskLabel,
  TaskPreset,
  TaskPriority,
  TaskProject,
  TaskSnapshot,
  TaskStatus,
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
  TaskProjectRowSchema,
  TaskRowSchema,
  selectAll,
  selectOne,
  type TaskAttachmentRow,
  type TaskCommentRow,
  type TaskPresetRow,
  type TaskProjectRow,
  type TaskRow,
} from "./rows.js";
import { migrateTasksDatabase } from "./schema.js";

/** Gap between neighbours, so an insert between two of them halves the gap
 * instead of renumbering the column. */
const POSITION_STEP = 1024;

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
}

export interface CreateTaskCommentInput {
  taskId: string;
  kind: TaskComment["kind"];
  authorName: string;
  agentId?: string | null;
  workspaceId?: string | null;
  body: string;
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
  instructions?: string;
  environmentKind: TaskPreset["environmentKind"];
  baseBranch?: string | null;
}

function toProject(row: TaskProjectRow): TaskProject {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    color: row.color,
    paseoProjectId: row.paseo_project_id,
    createdAt: row.created_at,
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
    instructions: row.instructions,
    environmentKind: row.environment_kind,
    baseBranch: row.base_branch,
    createdAt: row.created_at,
  };
}

/**
 * The tracker's persistence. Every method is one statement or one transaction —
 * callers never read, merge and write back, so two writers cannot lose each
 * other's work.
 */
export class TaskStore {
  private readonly db: DatabaseSync;
  private readonly now: () => Date;

  constructor(input: { databasePath: string; now?: () => Date }) {
    if (input.databasePath !== ":memory:") {
      mkdirSync(dirname(input.databasePath), { recursive: true });
    }
    this.db = new DatabaseSync(input.databasePath);
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
      this.db.exec("ROLLBACK");
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
    const id = generateId("tprj");
    const prefix = input.prefix.trim().toUpperCase();
    const name = input.name.trim();
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

      const status = input.status ?? "backlog";
      const id = generateId("task");
      const timestamp = this.timestamp();

      this.db
        .prepare(
          `INSERT INTO tasks (
             id, project_id, number, title, description, status, priority,
             due_date, parent_task_id, position, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        );

      this.replaceLabels(id, input.labelIds ?? []);
      return this.requireTask(id);
    });
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
    return this.transaction(() => {
      const current = this.requireTaskRow(input.taskId);
      // Moving between statuses lands the task at the end of its new column;
      // an explicit drop uses moveTask instead.
      const status = input.status ?? current.status;
      const position =
        status === current.status
          ? current.position
          : this.nextPosition(current.project_id, status);

      this.db
        .prepare(
          `UPDATE tasks SET
             title = ?, description = ?, status = ?, priority = ?,
             due_date = ?, parent_task_id = ?, position = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          input.title?.trim() ?? current.title,
          input.description ?? current.description,
          status,
          input.priority ?? current.priority,
          input.dueDate === undefined ? current.due_date : input.dueDate,
          input.parentTaskId === undefined ? current.parent_task_id : input.parentTaskId,
          position,
          this.timestamp(),
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
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
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
    };
  }

  // --- Agents ---

  attachAgent(input: {
    taskId: string;
    agentId: string;
    workspaceId: string;
    presetId?: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO task_agents (task_id, agent_id, workspace_id, preset_id, attached_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (task_id, agent_id) DO UPDATE SET workspace_id = excluded.workspace_id`,
      )
      .run(
        input.taskId,
        input.agentId,
        input.workspaceId,
        input.presetId ?? null,
        this.timestamp(),
      );
  }

  detachAgent(input: { taskId: string; agentId: string }): void {
    this.db
      .prepare("DELETE FROM task_agents WHERE task_id = ? AND agent_id = ?")
      .run(input.taskId, input.agentId);
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
    this.db
      .prepare(
        `INSERT INTO task_comments (
           id, task_id, kind, author_name, agent_id, workspace_id, body, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.taskId,
        input.kind,
        input.authorName,
        input.agentId ?? null,
        input.workspaceId ?? null,
        input.body,
        createdAt,
      );
    return {
      id,
      taskId: input.taskId,
      kind: input.kind,
      authorName: input.authorName,
      agentId: input.agentId ?? null,
      workspaceId: input.workspaceId ?? null,
      body: input.body,
      attachments: [],
      createdAt,
    };
  }

  listComments(taskId: string): TaskComment[] {
    return selectAll(
      this.db.prepare("SELECT * FROM task_comments WHERE task_id = ? ORDER BY created_at, id"),
      TaskCommentRowSchema,
      "task_comments",
      [taskId],
    ).map((row) => this.toComment(row));
  }

  private toComment(row: TaskCommentRow): TaskComment {
    return {
      id: row.id,
      taskId: row.task_id,
      kind: row.kind,
      authorName: row.author_name,
      agentId: row.agent_id,
      workspaceId: row.workspace_id,
      body: row.body,
      attachments: this.listAttachments({ commentId: row.id }),
      createdAt: row.created_at,
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
    this.db
      .prepare(
        `INSERT INTO task_presets (
           id, name, provider, model, mode_id, thinking_option_id, instructions,
           environment_kind, base_branch, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.name.trim(),
        input.provider,
        input.model ?? null,
        input.modeId ?? null,
        input.thinkingOptionId ?? null,
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
