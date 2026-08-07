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
      expect(versions).toEqual([1, 2]);

      const project = second.prepare("SELECT * FROM task_projects WHERE id = 'tprj_1'").get() as {
        name: string;
        review_enabled: number;
        review_on_reject: string;
        archive_workspaces_on_done: number;
      };
      expect(project.name).toBe("Paseo");
      expect(project.review_enabled).toBe(0);
      expect(project.review_on_reject).toBe("in_progress");
      expect(project.archive_workspaces_on_done).toBe(0);

      const task = second.prepare("SELECT title FROM tasks WHERE id = 'tsk_1'").get() as {
        title: string;
      };
      expect(task.title).toBe("Ship it");
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
      expect(applied.total).toBe(2);
    } finally {
      second.close();
    }
  });
});
