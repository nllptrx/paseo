import type { DatabaseSync } from "node:sqlite";

/**
 * Append-only. A released version has applied every migration before it, so an
 * entry may never be edited or removed — add a new one.
 */
const MIGRATIONS: readonly string[] = [
  `
    CREATE TABLE task_projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      prefix TEXT NOT NULL UNIQUE COLLATE NOCASE,
      next_task_number INTEGER NOT NULL DEFAULT 1 CHECK (next_task_number >= 1),
      color TEXT NOT NULL,
      paseo_project_id TEXT,
      created_at TEXT NOT NULL,
      CHECK (prefix = upper(prefix)),
      CHECK (length(prefix) BETWEEN 1 AND 8)
    );

    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES task_projects(id) ON DELETE CASCADE,
      number INTEGER NOT NULL CHECK (number >= 1),
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL CHECK (
        status IN ('backlog', 'todo', 'in_progress', 'in_review', 'done', 'canceled')
      ),
      priority TEXT NOT NULL CHECK (priority IN ('urgent', 'high', 'medium', 'low', 'none')),
      due_date TEXT,
      parent_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
      position REAL NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (project_id, number),
      CHECK (parent_task_id IS NULL OR parent_task_id <> id),
      CHECK (due_date IS NULL OR due_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')
    );

    CREATE TABLE task_labels (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES task_projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL COLLATE NOCASE,
      color TEXT NOT NULL,
      UNIQUE (project_id, name)
    );

    CREATE TABLE task_label_links (
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      label_id TEXT NOT NULL REFERENCES task_labels(id) ON DELETE CASCADE,
      PRIMARY KEY (task_id, label_id)
    );

    CREATE TABLE task_comments (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('user', 'agent', 'system')),
      author_name TEXT NOT NULL,
      agent_id TEXT,
      workspace_id TEXT,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE task_attachments (
      id TEXT PRIMARY KEY,
      task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
      comment_id TEXT REFERENCES task_comments(id) ON DELETE CASCADE,
      file_name TEXT NOT NULL,
      mime TEXT NOT NULL,
      size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
      blob_path TEXT NOT NULL,
      is_image INTEGER NOT NULL CHECK (is_image IN (0, 1)),
      created_at TEXT NOT NULL,
      CHECK (
        (task_id IS NOT NULL AND comment_id IS NULL)
        OR (task_id IS NULL AND comment_id IS NOT NULL)
      )
    );

    -- Only the attachment. Whether that agent is working, idle or failed is read
    -- off the agent itself; a copy here would be a second answer to a question
    -- the agent already answers.
    CREATE TABLE task_agents (
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      preset_id TEXT,
      attached_at TEXT NOT NULL,
      PRIMARY KEY (task_id, agent_id)
    );

    CREATE TABLE task_presets (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE COLLATE NOCASE,
      provider TEXT NOT NULL,
      model TEXT,
      mode_id TEXT,
      thinking_option_id TEXT,
      instructions TEXT NOT NULL DEFAULT '',
      environment_kind TEXT NOT NULL CHECK (
        environment_kind IN ('project_default', 'new_worktree')
      ),
      base_branch TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX idx_tasks_board ON tasks(project_id, status, position, id);
    CREATE INDEX idx_tasks_parent ON tasks(parent_task_id, position);
    CREATE INDEX idx_task_label_links_label ON task_label_links(label_id, task_id);
    CREATE INDEX idx_task_comments_order ON task_comments(task_id, created_at, id);
    CREATE INDEX idx_task_attachments_task ON task_attachments(task_id);
    CREATE INDEX idx_task_attachments_comment ON task_attachments(comment_id);
    CREATE INDEX idx_task_agents_agent ON task_agents(agent_id);

    CREATE TABLE task_revision (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      revision INTEGER NOT NULL CHECK (revision >= 0)
    );
    INSERT INTO task_revision (id, revision) VALUES (1, 0);

    CREATE TRIGGER task_revision_tasks_insert AFTER INSERT ON tasks BEGIN
      UPDATE task_revision SET revision = revision + 1 WHERE id = 1;
    END;
    CREATE TRIGGER task_revision_tasks_update AFTER UPDATE ON tasks BEGIN
      UPDATE task_revision SET revision = revision + 1 WHERE id = 1;
    END;
    CREATE TRIGGER task_revision_tasks_delete AFTER DELETE ON tasks BEGIN
      UPDATE task_revision SET revision = revision + 1 WHERE id = 1;
    END;
    CREATE TRIGGER task_revision_labels_insert AFTER INSERT ON task_label_links BEGIN
      UPDATE task_revision SET revision = revision + 1 WHERE id = 1;
    END;
    CREATE TRIGGER task_revision_labels_delete AFTER DELETE ON task_label_links BEGIN
      UPDATE task_revision SET revision = revision + 1 WHERE id = 1;
    END;
    CREATE TRIGGER task_revision_label_rename AFTER UPDATE OF name, color ON task_labels BEGIN
      UPDATE task_revision SET revision = revision + 1 WHERE id = 1;
    END;
    CREATE TRIGGER task_revision_agents_insert AFTER INSERT ON task_agents BEGIN
      UPDATE task_revision SET revision = revision + 1 WHERE id = 1;
    END;
    CREATE TRIGGER task_revision_agents_delete AFTER DELETE ON task_agents BEGIN
      UPDATE task_revision SET revision = revision + 1 WHERE id = 1;
    END;
    CREATE TRIGGER task_revision_comments_insert AFTER INSERT ON task_comments BEGIN
      UPDATE task_revision SET revision = revision + 1 WHERE id = 1;
    END;
    CREATE TRIGGER task_revision_projects_update AFTER UPDATE OF prefix, name ON task_projects BEGIN
      UPDATE task_revision SET revision = revision + 1 WHERE id = 1;
    END;
  `,
  `
    -- The project is the board, so board behaviour lives on it rather than in a
    -- separate kanban record.
    ALTER TABLE task_projects ADD COLUMN review_enabled INTEGER NOT NULL DEFAULT 0
      CHECK (review_enabled IN (0, 1));
    ALTER TABLE task_projects ADD COLUMN review_on_reject TEXT NOT NULL DEFAULT 'in_progress'
      CHECK (review_on_reject IN ('in_progress', 'todo', 'backlog'));
    ALTER TABLE task_projects ADD COLUMN archive_workspaces_on_done INTEGER NOT NULL DEFAULT 0
      CHECK (archive_workspaces_on_done IN (0, 1));

    -- Steps stay a document: they are read and rewritten whole on every run, and
    -- the shape (agent specs, trigger, run history) is validated by one schema.
    CREATE TABLE task_workflows (
      task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
      steps TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE task_dependencies (
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      depends_on_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      PRIMARY KEY (task_id, depends_on_task_id),
      CHECK (task_id <> depends_on_task_id)
    );

    CREATE INDEX idx_task_dependencies_reverse
      ON task_dependencies(depends_on_task_id, task_id);

    CREATE TRIGGER task_revision_workflows_insert AFTER INSERT ON task_workflows BEGIN
      UPDATE task_revision SET revision = revision + 1 WHERE id = 1;
    END;
    CREATE TRIGGER task_revision_workflows_update AFTER UPDATE ON task_workflows BEGIN
      UPDATE task_revision SET revision = revision + 1 WHERE id = 1;
    END;
    CREATE TRIGGER task_revision_workflows_delete AFTER DELETE ON task_workflows BEGIN
      UPDATE task_revision SET revision = revision + 1 WHERE id = 1;
    END;
    CREATE TRIGGER task_revision_deps_insert AFTER INSERT ON task_dependencies BEGIN
      UPDATE task_revision SET revision = revision + 1 WHERE id = 1;
    END;
    CREATE TRIGGER task_revision_deps_delete AFTER DELETE ON task_dependencies BEGIN
      UPDATE task_revision SET revision = revision + 1 WHERE id = 1;
    END;
    CREATE TRIGGER task_revision_board_update
      AFTER UPDATE OF review_enabled, review_on_reject, archive_workspaces_on_done
      ON task_projects
    BEGIN
      UPDATE task_revision SET revision = revision + 1 WHERE id = 1;
    END;
  `,
];

export function migrateTasksDatabase(db: DatabaseSync): void {
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);

  const applied = new Set(
    db
      .prepare("SELECT version FROM schema_version")
      .all()
      .map((row) => Number((row as { version: number }).version)),
  );

  for (const [index, sql] of MIGRATIONS.entries()) {
    const version = index + 1;
    if (applied.has(version)) {
      continue;
    }
    db.exec("BEGIN");
    try {
      db.exec(sql);
      db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)").run(
        version,
        new Date().toISOString(),
      );
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}
