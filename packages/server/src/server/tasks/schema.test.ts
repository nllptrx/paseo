import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrateTasksDatabase } from "./schema.js";

/**
 * Rewinds a fully migrated database to what version 1 left behind, so the
 * upgrade path can be exercised against rows that already exist. A user's
 * tasks.db is the one database the daemon cannot recreate.
 */
function rewindToVersion1(db: DatabaseSync): void {
  db.exec("ALTER TABLE task_presets DROP COLUMN feature_values");
  db.exec("DELETE FROM schema_version WHERE version = 12");
  db.exec("DELETE FROM schema_version WHERE version = 11");
  db.exec("DROP TRIGGER task_revision_comment_delivery_update");
  db.exec("DELETE FROM schema_version WHERE version = 9");
  db.exec("ALTER TABLE task_agents DROP COLUMN completion_owner");
  db.exec("DELETE FROM schema_version WHERE version = 6");
  db.exec("DROP TRIGGER task_revision_review_policy_update");
  db.exec("ALTER TABLE tasks DROP COLUMN review_iteration");
  db.exec("ALTER TABLE task_projects DROP COLUMN max_review_iterations");
  db.exec("DELETE FROM schema_version WHERE version = 5");
  db.exec("ALTER TABLE task_agents DROP COLUMN role");
  db.exec("ALTER TABLE task_projects DROP COLUMN reviewer_preset_id");
  db.exec("DELETE FROM schema_version WHERE version = 4");
  db.exec("DROP TRIGGER task_revision_comments_insert");
  db.exec("DROP INDEX idx_task_comments_feed");
  db.exec("DROP INDEX idx_task_comments_order");
  db.exec("ALTER TABLE task_comments RENAME TO task_comments_v3");
  db.exec(`
    CREATE TABLE task_comments (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('user', 'agent', 'system')),
      author_name TEXT NOT NULL,
      agent_id TEXT,
      workspace_id TEXT,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);
  db.exec(`
    INSERT INTO task_comments (id, task_id, kind, author_name, agent_id, workspace_id, body, created_at)
    SELECT id, task_id, kind, author_name, agent_id, workspace_id, body, created_at
    FROM task_comments_v3 WHERE task_id IS NOT NULL
  `);
  db.exec("DROP TABLE task_comments_v3");
  db.exec("CREATE INDEX idx_task_comments_order ON task_comments(task_id, created_at, id)");
  db.exec(`
    CREATE TRIGGER task_revision_comments_insert AFTER INSERT ON task_comments BEGIN
      UPDATE task_revision SET revision = revision + 1 WHERE id = 1;
    END
  `);
  db.exec("DELETE FROM schema_version WHERE version = 3");
  db.exec("DROP TRIGGER task_revision_workflows_insert");
  db.exec("DROP TRIGGER task_revision_workflows_update");
  db.exec("DROP TRIGGER task_revision_workflows_delete");
  db.exec("DROP TRIGGER task_revision_deps_insert");
  db.exec("DROP TRIGGER task_revision_deps_delete");
  db.exec("DROP TRIGGER task_revision_board_update");
  db.exec("DROP TABLE task_workflows");
  db.exec("DROP TABLE task_dependencies");
  db.exec("ALTER TABLE task_projects DROP COLUMN review_enabled");
  db.exec("ALTER TABLE task_projects DROP COLUMN review_on_reject");
  db.exec("ALTER TABLE task_projects DROP COLUMN archive_workspaces_on_done");
  db.exec("DELETE FROM schema_version WHERE version = 2");
}

describe("migrateTasksDatabase", () => {
  let directory: string;
  let databasePath: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "paseo-tasks-schema-"));
    databasePath = join(directory, "tasks.db");
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it("upgrades a version 1 database without losing its rows", () => {
    const first = new DatabaseSync(databasePath);
    migrateTasksDatabase(first);
    first
      .prepare(
        `INSERT INTO task_projects (id, name, prefix, color, paseo_project_id, created_at)
         VALUES ('tprj_1', 'Paseo', 'PSE', '#fff', 'proj-1', '2026-01-01T00:00:00.000Z')`,
      )
      .run();
    first
      .prepare(
        `INSERT INTO tasks (id, project_id, number, title, status, priority, position, created_at, updated_at)
         VALUES ('tsk_1', 'tprj_1', 1, 'Ship it', 'todo', 'none', 1024,
                 '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      )
      .run();
    rewindToVersion1(first);
    first.close();

    const second = new DatabaseSync(databasePath);
    try {
      migrateTasksDatabase(second);

      const versions = second
        .prepare("SELECT version FROM schema_version ORDER BY version")
        .all()
        .map((row) => (row as { version: number }).version);
      expect(versions).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);

      const project = second.prepare("SELECT * FROM task_projects WHERE id = 'tprj_1'").get() as {
        name: string;
        review_enabled: number;
        review_on_reject: string;
        archive_workspaces_on_done: number;
        max_review_iterations: number;
      };
      expect(project.name).toBe("Paseo");
      expect(project.review_enabled).toBe(0);
      expect(project.review_on_reject).toBe("in_progress");
      expect(project.archive_workspaces_on_done).toBe(0);
      expect(project.max_review_iterations).toBe(3);

      const task = second.prepare("SELECT * FROM tasks WHERE id = 'tsk_1'").get() as {
        title: string;
        review_iteration: number;
        execution_policy: string | null;
        integration_branch: string | null;
        integration_status: string | null;
        integration_error: string | null;
      };
      expect(task.title).toBe("Ship it");
      expect(task.review_iteration).toBe(0);
      expect(task.execution_policy).toBeNull();
      expect(task.integration_branch).toBeNull();
      expect(task.integration_status).toBeNull();
      expect(task.integration_error).toBeNull();

      const agentColumns = second
        .prepare("PRAGMA table_info(task_agents)")
        .all()
        .map((row) => (row as { name: string }).name);
      expect(agentColumns).toContain("completion_owner");
    } finally {
      second.close();
    }
  });

  it("is a no-op when every migration has already been applied", () => {
    const first = new DatabaseSync(databasePath);
    migrateTasksDatabase(first);
    first.close();

    const second = new DatabaseSync(databasePath);
    try {
      expect(() => migrateTasksDatabase(second)).not.toThrow();
      const applied = second.prepare("SELECT count(*) AS total FROM schema_version").get() as {
        total: number;
      };
      expect(applied.total).toBe(12);
    } finally {
      second.close();
    }
  });
});
