import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  Task,
  TaskAttachment,
  TaskComment,
  TaskLabel,
  TaskPreset,
  TaskPriority,
  TaskProject,
  TaskSnapshot,
  TaskStatus,
} from "@getpaseo/protocol/tasks/types";
import { migrateTasksDatabase } from "./schema.js";

/** Gap between neighbours, so an insert between two of them halves the gap
 * instead of renumbering the column. */
const POSITION_STEP = 1024;

function generateId(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

function toBool(value: unknown): boolean {
  return value === 1 || value === true;
}

function toNullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
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
    const row = this.db.prepare("SELECT revision FROM task_revision WHERE id = 1").get() as
      | { revision: number }
      | undefined;
    return Number(row?.revision ?? 0);
  }

  // --- Projects ---

  createProject(input: CreateTaskProjectInput): TaskProject {
    const id = generateId("tprj");
    const prefix = input.prefix.trim().toUpperCase();
    const createdAt = this.timestamp();
    this.db
      .prepare(
        `INSERT INTO task_projects (id, name, prefix, color, paseo_project_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.name.trim(), prefix, input.color, input.paseoProjectId ?? null, createdAt);
    return {
      id,
      name: input.name.trim(),
      prefix,
      color: input.color,
      paseoProjectId: input.paseoProjectId ?? null,
      createdAt,
    };
  }

  listProjects(): TaskProject[] {
    return this.db
      .prepare("SELECT * FROM task_projects ORDER BY name COLLATE NOCASE, id")
      .all()
      .map((row) => this.rowToProject(row as Record<string, unknown>));
  }

  private rowToProject(row: Record<string, unknown>): TaskProject {
    return {
      id: String(row.id),
      name: String(row.name),
      prefix: String(row.prefix),
      color: String(row.color),
      paseoProjectId: toNullableString(row.paseo_project_id),
      createdAt: String(row.created_at),
    };
  }

  // --- Labels ---

  createLabel(input: { projectId: string; name: string; color: string }): TaskLabel {
    const id = generateId("tlbl");
    this.db
      .prepare("INSERT INTO task_labels (id, project_id, name, color) VALUES (?, ?, ?, ?)")
      .run(id, input.projectId, input.name.trim(), input.color);
    return { id, projectId: input.projectId, name: input.name.trim(), color: input.color };
  }

  listLabels(): TaskLabel[] {
    return this.db
      .prepare("SELECT * FROM task_labels ORDER BY name COLLATE NOCASE, id")
      .all()
      .map((row) => {
        const record = row as Record<string, unknown>;
        return {
          id: String(record.id),
          projectId: String(record.project_id),
          name: String(record.name),
          color: String(record.color),
        };
      });
  }

  deleteLabel(labelId: string): void {
    this.db.prepare("DELETE FROM task_labels WHERE id = ?").run(labelId);
  }

  // --- Tasks ---

  createTask(input: CreateTaskInput): Task {
    return this.transaction(() => {
      const projectRow = this.db
        .prepare("SELECT next_task_number FROM task_projects WHERE id = ?")
        .get(input.projectId) as { next_task_number: number } | undefined;
      if (!projectRow) {
        throw new Error(`Unknown task project ${input.projectId}`);
      }
      const number = Number(projectRow.next_task_number);
      this.db
        .prepare("UPDATE task_projects SET next_task_number = ? WHERE id = ?")
        .run(number + 1, input.projectId);

      const status = input.status ?? "backlog";
      const id = generateId("task");
      const timestamp = this.timestamp();
      const position = this.nextPosition(input.projectId, status);

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
          position,
          timestamp,
          timestamp,
        );

      this.replaceLabels(id, input.labelIds ?? []);
      return this.requireTask(id);
    });
  }

  private nextPosition(projectId: string, status: TaskStatus): number {
    const row = this.db
      .prepare("SELECT MAX(position) AS top FROM tasks WHERE project_id = ? AND status = ?")
      .get(projectId, status) as { top: number | null } | undefined;
    const top = row?.top;
    return typeof top === "number" ? top + POSITION_STEP : POSITION_STEP;
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
      const status = input.status ?? (current.status as TaskStatus);
      const position =
        input.status && input.status !== current.status
          ? this.nextPosition(String(current.project_id), status)
          : Number(current.position);

      this.db
        .prepare(
          `UPDATE tasks SET
             title = ?, description = ?, status = ?, priority = ?,
             due_date = ?, parent_task_id = ?, position = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          input.title?.trim() ?? String(current.title),
          input.description ?? String(current.description),
          status,
          input.priority ?? (current.priority as TaskPriority),
          input.dueDate === undefined ? toNullableString(current.due_date) : input.dueDate,
          input.parentTaskId === undefined
            ? toNullableString(current.parent_task_id)
            : input.parentTaskId,
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
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as
      | Record<string, unknown>
      | undefined;
    return row ? this.rowToTask(row) : null;
  }

  private requireTask(taskId: string): Task {
    const task = this.getTask(taskId);
    if (!task) {
      throw new Error(`Unknown task ${taskId}`);
    }
    return task;
  }

  private requireTaskRow(taskId: string): Record<string, unknown> {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as
      | Record<string, unknown>
      | undefined;
    if (!row) {
      throw new Error(`Unknown task ${taskId}`);
    }
    return row;
  }

  private rowToTask(row: Record<string, unknown>): Task {
    const id = String(row.id);
    return {
      id,
      projectId: String(row.project_id),
      number: Number(row.number),
      title: String(row.title),
      description: String(row.description),
      status: row.status as TaskStatus,
      priority: row.priority as TaskPriority,
      dueDate: toNullableString(row.due_date),
      parentTaskId: toNullableString(row.parent_task_id),
      position: Number(row.position),
      labelIds: this.db
        .prepare("SELECT label_id FROM task_label_links WHERE task_id = ?")
        .all(id)
        .map((entry) => String((entry as { label_id: string }).label_id)),
      agents: this.listTaskAgents(id),
      attachments: this.listAttachments({ taskId: id }),
      commentCount: Number(
        (
          this.db
            .prepare("SELECT COUNT(*) AS total FROM task_comments WHERE task_id = ?")
            .get(id) as { total: number }
        ).total,
      ),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  /** One read for a whole view, stamped with the revision it saw. */
  snapshot(): TaskSnapshot {
    const tasks = this.db
      .prepare("SELECT * FROM tasks ORDER BY project_id, status, position, id")
      .all()
      .map((row) => this.rowToTask(row as Record<string, unknown>));
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

  listTaskAgents(taskId: string): Task["agents"] {
    return this.db
      .prepare("SELECT * FROM task_agents WHERE task_id = ? ORDER BY attached_at, agent_id")
      .all(taskId)
      .map((row) => {
        const record = row as Record<string, unknown>;
        return {
          agentId: String(record.agent_id),
          workspaceId: String(record.workspace_id),
          presetId: toNullableString(record.preset_id),
          attachedAt: String(record.attached_at),
        };
      });
  }

  findTasksByAgent(agentId: string): string[] {
    return this.db
      .prepare("SELECT task_id FROM task_agents WHERE agent_id = ?")
      .all(agentId)
      .map((row) => String((row as { task_id: string }).task_id));
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
    return this.db
      .prepare("SELECT * FROM task_comments WHERE task_id = ? ORDER BY created_at, id")
      .all(taskId)
      .map((row) => {
        const record = row as Record<string, unknown>;
        const id = String(record.id);
        return {
          id,
          taskId: String(record.task_id),
          kind: record.kind as TaskComment["kind"],
          authorName: String(record.author_name),
          agentId: toNullableString(record.agent_id),
          workspaceId: toNullableString(record.workspace_id),
          body: String(record.body),
          attachments: this.listAttachments({ commentId: id }),
          createdAt: String(record.created_at),
        };
      });
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
    const [column, value] = scope.taskId
      ? ["task_id", scope.taskId]
      : ["comment_id", scope.commentId ?? ""];
    return this.db
      .prepare(`SELECT * FROM task_attachments WHERE ${column} = ? ORDER BY created_at, id`)
      .all(value)
      .map((row) => {
        const record = row as Record<string, unknown>;
        return {
          id: String(record.id),
          fileName: String(record.file_name),
          mime: String(record.mime),
          sizeBytes: Number(record.size_bytes),
          isImage: toBool(record.is_image),
          createdAt: String(record.created_at),
        };
      });
  }

  getAttachmentBlobPath(attachmentId: string): string | null {
    const row = this.db
      .prepare("SELECT blob_path FROM task_attachments WHERE id = ?")
      .get(attachmentId) as { blob_path: string } | undefined;
    return row ? String(row.blob_path) : null;
  }

  // --- Presets ---

  createPreset(input: CreateTaskPresetInput): TaskPreset {
    const id = generateId("tpst");
    const createdAt = this.timestamp();
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
        createdAt,
      );
    return this.requirePreset(id);
  }

  listPresets(): TaskPreset[] {
    return this.db
      .prepare("SELECT * FROM task_presets ORDER BY name COLLATE NOCASE, id")
      .all()
      .map((row) => this.rowToPreset(row as Record<string, unknown>));
  }

  getPreset(presetId: string): TaskPreset | null {
    const row = this.db.prepare("SELECT * FROM task_presets WHERE id = ?").get(presetId) as
      | Record<string, unknown>
      | undefined;
    return row ? this.rowToPreset(row) : null;
  }

  private requirePreset(presetId: string): TaskPreset {
    const preset = this.getPreset(presetId);
    if (!preset) {
      throw new Error(`Unknown preset ${presetId}`);
    }
    return preset;
  }

  deletePreset(presetId: string): void {
    this.db.prepare("DELETE FROM task_presets WHERE id = ?").run(presetId);
  }

  private rowToPreset(row: Record<string, unknown>): TaskPreset {
    return {
      id: String(row.id),
      name: String(row.name),
      provider: String(row.provider) as TaskPreset["provider"],
      model: toNullableString(row.model),
      modeId: toNullableString(row.mode_id),
      thinkingOptionId: toNullableString(row.thinking_option_id),
      instructions: String(row.instructions),
      environmentKind: row.environment_kind as TaskPreset["environmentKind"],
      baseBranch: toNullableString(row.base_branch),
      createdAt: String(row.created_at),
    };
  }
}
