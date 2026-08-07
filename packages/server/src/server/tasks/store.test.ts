import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TaskRowShapeError } from "./rows.js";
import { openTaskStore, type TaskStore } from "./store.js";

async function createStore(): Promise<TaskStore> {
  let tick = 0;
  return openTaskStore({
    databasePath: ":memory:",
    now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)),
  });
}

describe("TaskStore", () => {
  let store: TaskStore;
  let projectId: string;

  beforeEach(async () => {
    store = await createStore();
    projectId = store.createProject({ name: "Paseo", prefix: "pse", color: "#fff" }).id;
  });

  it("uppercases the prefix and refuses a duplicate", () => {
    expect(store.listProjects()[0]?.prefix).toBe("PSE");
    expect(() => store.createProject({ name: "Other", prefix: "PSE", color: "#000" })).toThrow();
  });

  it("allocates task numbers in sequence and never reuses one", () => {
    const first = store.createTask({ projectId, title: "One" });
    const second = store.createTask({ projectId, title: "Two" });
    expect([first.number, second.number]).toEqual([1, 2]);

    store.deleteTask(first.id);
    expect(store.createTask({ projectId, title: "Three" }).number).toBe(3);
  });

  it("numbers each project independently", () => {
    const other = store.createProject({ name: "Relay", prefix: "RLY", color: "#000" }).id;
    expect(store.createTask({ projectId, title: "A" }).number).toBe(1);
    expect(store.createTask({ projectId: other, title: "B" }).number).toBe(1);
  });

  it("defaults a new task to backlog with no priority", () => {
    const task = store.createTask({ projectId, title: "Draft" });
    expect(task.status).toBe("backlog");
    expect(task.priority).toBe("none");
    expect(task.agents).toEqual([]);
    expect(task.commentCount).toBe(0);
  });

  it("appends to the end of a column and moves between two neighbours", () => {
    const first = store.createTask({ projectId, title: "One", status: "todo" });
    const second = store.createTask({ projectId, title: "Two", status: "todo" });
    expect(second.position).toBeGreaterThan(first.position);

    const third = store.createTask({ projectId, title: "Three", status: "todo" });
    const moved = store.moveTask({
      taskId: third.id,
      status: "todo",
      beforePosition: first.position,
      afterPosition: second.position,
    });
    expect(moved.position).toBeGreaterThan(first.position);
    expect(moved.position).toBeLessThan(second.position);
  });

  it("sends a task changing status to the end of its new column", () => {
    const parked = store.createTask({ projectId, title: "Parked", status: "todo" });
    const task = store.createTask({ projectId, title: "Moving", status: "backlog" });

    const updated = store.updateTask({ taskId: task.id, status: "todo" });

    expect(updated.status).toBe("todo");
    expect(updated.position).toBeGreaterThan(parked.position);
  });

  it("keeps position when an update does not change status", () => {
    const task = store.createTask({ projectId, title: "Stay", status: "todo" });
    const updated = store.updateTask({ taskId: task.id, priority: "high" });
    expect(updated.position).toBe(task.position);
    expect(updated.priority).toBe("high");
  });

  it("replaces the label set rather than merging it", () => {
    const red = store.createLabel({ projectId, name: "red", color: "#f00" });
    const blue = store.createLabel({ projectId, name: "blue", color: "#00f" });
    const task = store.createTask({ projectId, title: "Labelled", labelIds: [red.id] });
    expect(task.labelIds).toEqual([red.id]);

    expect(store.updateTask({ taskId: task.id, labelIds: [blue.id] }).labelIds).toEqual([blue.id]);
  });

  it("drops label links when the label is deleted", () => {
    const label = store.createLabel({ projectId, name: "gone", color: "#f00" });
    const task = store.createTask({ projectId, title: "Labelled", labelIds: [label.id] });

    store.deleteLabel(label.id);

    expect(store.getTask(task.id)?.labelIds).toEqual([]);
  });

  it("attaches an agent once however many times it is attached", () => {
    const task = store.createTask({ projectId, title: "Worked" });
    store.attachAgent({ taskId: task.id, agentId: "agt_1", workspaceId: "ws_1" });
    store.attachAgent({ taskId: task.id, agentId: "agt_1", workspaceId: "ws_2" });

    const agents = store.listTaskAgents(task.id);
    expect(agents).toHaveLength(1);
    expect(agents[0]?.workspaceId).toBe("ws_2");
    expect(store.findTasksByAgent("agt_1")).toEqual([task.id]);

    store.detachAgent({ taskId: task.id, agentId: "agt_1" });
    expect(store.listTaskAgents(task.id)).toEqual([]);
  });

  it("counts comments on the task and carries their agent authorship", () => {
    const task = store.createTask({ projectId, title: "Discussed" });
    store.createComment({ taskId: task.id, kind: "user", authorName: "me", body: "why?" });
    store.createComment({
      taskId: task.id,
      kind: "agent",
      authorName: "Claude",
      agentId: "agt_1",
      workspaceId: "ws_1",
      body: "because",
    });

    expect(store.getTask(task.id)?.commentCount).toBe(2);
    const comments = store.listComments(task.id);
    expect(comments.map((entry) => entry.kind)).toEqual(["user", "agent"]);
    expect(comments[1]?.agentId).toBe("agt_1");
  });

  it("hangs an attachment off either a task or a comment, never both", () => {
    const task = store.createTask({ projectId, title: "Attached" });
    const comment = store.createComment({
      taskId: task.id,
      kind: "user",
      authorName: "me",
      body: "see this",
    });
    store.createAttachment({
      taskId: task.id,
      fileName: "spec.pdf",
      mime: "application/pdf",
      sizeBytes: 10,
      blobPath: "/blobs/a",
      isImage: false,
    });
    store.createAttachment({
      commentId: comment.id,
      fileName: "shot.png",
      mime: "image/png",
      sizeBytes: 20,
      blobPath: "/blobs/b",
      isImage: true,
    });

    expect(store.getTask(task.id)?.attachments.map((entry) => entry.fileName)).toEqual([
      "spec.pdf",
    ]);
    expect(store.listComments(task.id)[0]?.attachments[0]?.isImage).toBe(true);
    expect(() =>
      store.createAttachment({
        taskId: task.id,
        commentId: comment.id,
        fileName: "both.txt",
        mime: "text/plain",
        sizeBytes: 1,
        blobPath: "/blobs/c",
        isImage: false,
      }),
    ).toThrow();
  });

  it("deletes a task's comments, attachments and agent links with it", () => {
    const task = store.createTask({ projectId, title: "Doomed" });
    store.createComment({ taskId: task.id, kind: "user", authorName: "me", body: "hi" });
    store.attachAgent({ taskId: task.id, agentId: "agt_1", workspaceId: "ws_1" });

    store.deleteTask(task.id);

    expect(store.getTask(task.id)).toBeNull();
    expect(store.listComments(task.id)).toEqual([]);
    expect(store.findTasksByAgent("agt_1")).toEqual([]);
  });

  it("bumps the revision on every write a list view would notice", () => {
    const before = store.getRevision();
    const task = store.createTask({ projectId, title: "Watched" });
    const afterCreate = store.getRevision();
    expect(afterCreate).toBeGreaterThan(before);

    store.updateTask({ taskId: task.id, priority: "urgent" });
    const afterUpdate = store.getRevision();
    expect(afterUpdate).toBeGreaterThan(afterCreate);

    store.attachAgent({ taskId: task.id, agentId: "agt_1", workspaceId: "ws_1" });
    expect(store.getRevision()).toBeGreaterThan(afterUpdate);
  });

  it("does not bump the revision for a read", () => {
    store.createTask({ projectId, title: "Read" });
    const revision = store.getRevision();
    store.snapshot();
    expect(store.getRevision()).toBe(revision);
  });

  it("returns one snapshot stamped with the revision it read", () => {
    store.createTask({ projectId, title: "One", status: "todo" });
    store.createTask({ projectId, title: "Two", status: "done" });

    const snapshot = store.snapshot();

    expect(snapshot.revision).toBe(store.getRevision());
    expect(snapshot.projects).toHaveLength(1);
    expect(snapshot.tasks.map((task) => task.title)).toEqual(["Two", "One"]);
  });

  it("keeps presets addressable by name and unique", () => {
    const preset = store.createPreset({
      name: "Reviewer",
      provider: "claude",
      model: "opus",
      environmentKind: "new_worktree",
      baseBranch: "main",
    });

    expect(store.getPreset(preset.id)?.model).toBe("opus");
    expect(store.listPresets().map((entry) => entry.name)).toEqual(["Reviewer"]);
    expect(() =>
      store.createPreset({
        name: "reviewer",
        provider: "codex",
        environmentKind: "project_default",
      }),
    ).toThrow();
  });

  it("refuses a task on an unknown project without consuming a number", () => {
    expect(() => store.createTask({ projectId: "nope", title: "Orphan" })).toThrow();
    expect(store.createTask({ projectId, title: "First" }).number).toBe(1);
  });
});

describe("TaskStore row shape", () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "paseo-tasks-"));
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  /**
   * The reason this store parses rows instead of casting them: a database
   * written by a different build is a real state, and it has to be reported as
   * one rather than turning into undefined halfway up the call stack.
   */
  it("names the table when the database on disk has a different shape", async () => {
    const databasePath = join(directory, "tasks.db");
    const first = await openTaskStore({ databasePath });
    const projectId = first.createProject({ name: "Paseo", prefix: "PSE", color: "#fff" }).id;
    first.createTask({ projectId, title: "Before the change" });
    first.close();

    const raw = new DatabaseSync(databasePath);
    raw.exec("ALTER TABLE tasks RENAME COLUMN priority TO importance");
    raw.close();

    const second = await openTaskStore({ databasePath });
    try {
      let thrown: unknown;
      try {
        second.snapshot();
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(TaskRowShapeError);
      expect((thrown as TaskRowShapeError).table).toBe("tasks");
      expect((thrown as Error).message).toContain("priority");
    } finally {
      second.close();
    }
  });
  it("defaults a new project's board to no review and no archiving", async () => {
    const store = await openTaskStore({ databasePath: join(directory, "tasks.db") });
    try {
      const project = store.createProject({ name: "Paseo", prefix: "PSE", color: "#fff" });
      expect(project.board).toEqual({
        reviewEnabled: false,
        reviewOnReject: "in_progress",
        archiveWorkspacesOnDone: false,
      });
      expect(store.getProject(project.id)?.board).toEqual(project.board);
    } finally {
      store.close();
    }
  });

  it("keeps board settings the caller did not touch", async () => {
    const store = await openTaskStore({ databasePath: join(directory, "tasks.db") });
    try {
      const project = store.createProject({ name: "Paseo", prefix: "PSE", color: "#fff" });
      store.configureBoard({ projectId: project.id, reviewOnReject: "backlog" });
      const configured = store.configureBoard({ projectId: project.id, reviewEnabled: true });
      expect(configured.board).toEqual({
        reviewEnabled: true,
        reviewOnReject: "backlog",
        archiveWorkspacesOnDone: false,
      });
    } finally {
      store.close();
    }
  });

  it("replaces a task's workflow rather than accumulating them", async () => {
    const store = await openTaskStore({ databasePath: join(directory, "tasks.db") });
    try {
      const projectId = store.createProject({ name: "Paseo", prefix: "PSE", color: "#fff" }).id;
      const task = store.createTask({ projectId, title: "Ship it" });
      const step = {
        id: "stp_1",
        name: "Implement",
        prompt: "do the thing",
        agents: [{ provider: "claude" as const }],
        completion: "all" as const,
        workspace: { mode: "worktree" as const },
        trigger: { type: "immediate" as const },
        runs: [],
      };
      store.setWorkflow({ taskId: task.id, steps: [step] });
      store.setWorkflow({ taskId: task.id, steps: [step, { ...step, id: "stp_2" }] });

      expect(store.getWorkflow(task.id)?.steps).toHaveLength(2);
      expect(store.listWorkflows()).toHaveLength(1);

      store.clearWorkflow(task.id);
      expect(store.getWorkflow(task.id)).toBeNull();
    } finally {
      store.close();
    }
  });

  it("deletes a task's workflow with the task", async () => {
    const store = await openTaskStore({ databasePath: join(directory, "tasks.db") });
    try {
      const projectId = store.createProject({ name: "Paseo", prefix: "PSE", color: "#fff" }).id;
      const task = store.createTask({ projectId, title: "Ship it" });
      store.setWorkflow({
        taskId: task.id,
        steps: [
          {
            id: "stp_1",
            name: "Implement",
            prompt: "do the thing",
            agents: [{ provider: "claude" }],
            completion: "all",
            workspace: { mode: "worktree" },
            trigger: { type: "immediate" },
            runs: [],
          },
        ],
      });
      store.deleteTask(task.id);
      expect(store.listWorkflows()).toEqual([]);
    } finally {
      store.close();
    }
  });

  /** The gate reads intent, so a blocker that was canceled stops blocking — it is
   * never going to be done, and leaving it to block would strand the dependent. */
  it("counts only unfinished blockers as unmet dependencies", async () => {
    const store = await openTaskStore({ databasePath: join(directory, "tasks.db") });
    try {
      const projectId = store.createProject({ name: "Paseo", prefix: "PSE", color: "#fff" }).id;
      const blocked = store.createTask({ projectId, title: "Depends" });
      const open = store.createTask({ projectId, title: "Open blocker" });
      const finished = store.createTask({ projectId, title: "Finished blocker" });
      const dropped = store.createTask({ projectId, title: "Canceled blocker" });
      store.updateTask({ taskId: finished.id, status: "done" });
      store.updateTask({ taskId: dropped.id, status: "canceled" });

      for (const blocker of [open, finished, dropped]) {
        store.addDependency({ taskId: blocked.id, dependsOnTaskId: blocker.id });
      }

      expect(store.listUnmetDependencies(blocked.id)).toEqual([open.id]);

      store.removeDependency({ taskId: blocked.id, dependsOnTaskId: open.id });
      expect(store.listUnmetDependencies(blocked.id)).toEqual([]);
    } finally {
      store.close();
    }
  });
});
