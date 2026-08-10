import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TaskRowShapeError } from "./rows.js";
import { openTaskStore, type TaskStore } from "./store.js";

const logger = pino({ level: "silent" });

async function createStore(): Promise<TaskStore> {
  let tick = 0;
  return openTaskStore({
    logger,
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
    expect(() => store.createProject({ name: "Other", prefix: "pse", color: "#000" })).toThrow(
      "A task project with prefix PSE already exists",
    );
  });

  it("reuses the board already linked to a Paseo project", () => {
    const first = store.createProject({
      name: "Linked",
      prefix: "LNK",
      color: "#fff",
      paseoProjectId: "project-1",
    });
    const second = store.createProject({
      name: "Renamed",
      prefix: "NEW",
      color: "#000",
      paseoProjectId: "project-1",
    });

    expect(second).toEqual(first);
    expect(
      store.listProjects().filter((project) => project.paseoProjectId === "project-1"),
    ).toEqual([first]);
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

  it("validates due dates before SQLite writes or task-number allocation", () => {
    expect(() =>
      store.createTask({ projectId, title: "Timestamp", dueDate: "2026-09-01T10:00:00.000Z" }),
    ).toThrow("Due date must use YYYY-MM-DD");
    expect(() =>
      store.createTask({ projectId, title: "Impossible", dueDate: "2026-02-30" }),
    ).toThrow("real calendar date");

    const valid = store.createTask({ projectId, title: "Leap day", dueDate: "2028-02-29" });
    expect(valid.number).toBe(1);
    expect(() => store.updateTask({ taskId: valid.id, dueDate: "tomorrow" })).toThrow(
      "Due date must use YYYY-MM-DD",
    );
    expect(store.getTask(valid.id)?.dueDate).toBe("2028-02-29");
  });

  it("stores task execution exceptions and can return to board defaults", () => {
    const task = store.createTask({
      projectId,
      title: "Special",
      executionPolicy: {
        review: "required",
        workspace: "dedicated",
        subtaskReview: "disabled",
      },
    });
    expect(task.executionPolicy).toEqual({
      review: "required",
      workspace: "dedicated",
      subtaskReview: "disabled",
    });

    expect(store.updateTask({ taskId: task.id, executionPolicy: null }).executionPolicy).toBe(
      undefined,
    );
  });

  it("stores how a task starts itself and can stop it starting", () => {
    const task = store.createTask({
      projectId,
      title: "Phase two",
      executionSpec: { presetId: "tpst_1", trigger: "on_unblocked" },
    });
    expect(task.executionSpec).toEqual({ presetId: "tpst_1", trigger: "on_unblocked" });

    expect(store.updateTask({ taskId: task.id, executionSpec: null }).executionSpec).toBe(
      undefined,
    );
  });

  it("chains each new subtask behind the sibling created before it", () => {
    const parent = store.createTask({ projectId, title: "Parent" });
    const first = store.createTask({ projectId, title: "One", parentTaskId: parent.id });
    const second = store.createTask({ projectId, title: "Two", parentTaskId: parent.id });
    const third = store.createTask({ projectId, title: "Three", parentTaskId: parent.id });

    expect(store.listDependencies()).toEqual(
      expect.arrayContaining([
        { taskId: second.id, dependsOnTaskId: first.id },
        { taskId: third.id, dependsOnTaskId: second.id },
      ]),
    );
    expect(store.listDependencies()).toHaveLength(2);
  });

  it("leaves a parallel subtask ready alongside its predecessor", () => {
    const parent = store.createTask({ projectId, title: "Parent" });
    store.createTask({ projectId, title: "One", parentTaskId: parent.id });
    const parallel = store.createTask({
      projectId,
      title: "Two",
      parentTaskId: parent.id,
      parallel: true,
    });

    expect(store.listUnmetDependencies(parallel.id)).toEqual([]);
  });

  it("does not rewrite the edges a chain already stored when a subtask is edited", () => {
    const parent = store.createTask({ projectId, title: "Parent" });
    const first = store.createTask({ projectId, title: "One", parentTaskId: parent.id });
    const second = store.createTask({ projectId, title: "Two", parentTaskId: parent.id });
    store.removeDependency({ taskId: second.id, dependsOnTaskId: first.id });

    store.updateTask({ taskId: second.id, title: "Two, renamed" });

    expect(store.listDependencies()).toEqual([]);
  });

  it("reads a task's children and the tasks waiting on it", () => {
    const parent = store.createTask({ projectId, title: "Parent" });
    const child = store.createTask({ projectId, title: "Child", parentTaskId: parent.id });
    const after = store.createTask({ projectId, title: "After" });
    store.addDependency({ taskId: after.id, dependsOnTaskId: child.id });

    expect(store.listSubtasks(parent.id).map((task) => task.id)).toEqual([child.id]);
    expect(store.countSubtasks(parent.id)).toBe(1);
    expect(store.listDependents(child.id)).toEqual([after.id]);
  });

  it("persists the task branch and its delivery state", () => {
    const task = store.createTask({ projectId, title: "Integrated" });

    store.updateTask({
      taskId: task.id,
      integration: {
        branch: "paseo/tasks/pse-1",
        status: "conflicted",
        error: "conflict in src/task.ts",
      },
    });
    expect(store.getTask(task.id)?.integration).toEqual({
      branch: "paseo/tasks/pse-1",
      status: "conflicted",
      error: "conflict in src/task.ts",
    });

    store.updateTask({
      taskId: task.id,
      integration: { branch: "paseo/tasks/pse-1", status: "integrated", error: null },
    });
    expect(store.getTask(task.id)?.integration).toMatchObject({
      status: "integrated",
      error: null,
    });
  });

  it("keeps hierarchy within one board and rejects ancestry cycles", () => {
    const otherProject = store.createProject({ name: "Other", prefix: "OTH", color: "#fff" });
    const parent = store.createTask({ projectId, title: "Parent" });
    const child = store.createTask({ projectId, title: "Child", parentTaskId: parent.id });
    const other = store.createTask({ projectId: otherProject.id, title: "Other" });

    expect(() =>
      store.createTask({ projectId, title: "Cross-board", parentTaskId: other.id }),
    ).toThrow(/same project/);
    expect(() => store.updateTask({ taskId: parent.id, parentTaskId: child.id })).toThrow(
      /own ancestor/,
    );
  });

  it("keeps dependencies within one acyclic board graph", () => {
    const first = store.createTask({ projectId, title: "First" });
    const second = store.createTask({ projectId, title: "Second" });
    const third = store.createTask({ projectId, title: "Third" });
    const otherProjectId = store.createProject({
      name: "Other",
      prefix: "OTH",
      color: "#000",
    }).id;
    const outside = store.createTask({ projectId: otherProjectId, title: "Outside" });

    store.addDependency({ taskId: second.id, dependsOnTaskId: first.id });
    store.addDependency({ taskId: third.id, dependsOnTaskId: second.id });

    expect(() => store.addDependency({ taskId: first.id, dependsOnTaskId: third.id })).toThrow(
      "cannot create a cycle",
    );
    expect(() => store.addDependency({ taskId: first.id, dependsOnTaskId: first.id })).toThrow(
      "cannot depend on itself",
    );
    expect(() => store.addDependency({ taskId: first.id, dependsOnTaskId: outside.id })).toThrow(
      "must belong to the same project",
    );
    expect(store.listDependencies()).toEqual([
      { taskId: second.id, dependsOnTaskId: first.id },
      { taskId: third.id, dependsOnTaskId: second.id },
    ]);
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

  /** One deleted agent can be attached to several cards, and the link is the
   * only place membership lives, so the sweep addresses agents rather than
   * links. */
  it("prunes an agent's links on every task it was attached to", () => {
    const first = store.createTask({ projectId, title: "First" });
    const second = store.createTask({ projectId, title: "Second" });
    store.attachAgent({ taskId: first.id, agentId: "agt_gone", workspaceId: "ws_1" });
    store.attachAgent({ taskId: second.id, agentId: "agt_gone", workspaceId: "ws_2" });
    store.attachAgent({ taskId: second.id, agentId: "agt_live", workspaceId: "ws_2" });
    const before = store.getRevision();

    expect(store.pruneAgentLinks(["agt_gone"])).toBe(2);

    expect(store.findTasksByAgent("agt_gone")).toEqual([]);
    expect(store.listTaskAgents(second.id).map((link) => link.agentId)).toEqual(["agt_live"]);
    expect(store.getRevision()).toBeGreaterThan(before);
  });

  it("persists and updates who owns an attached agent's completion", () => {
    const task = store.createTask({ projectId, title: "Worked" });
    store.attachAgent({
      taskId: task.id,
      agentId: "agt_1",
      workspaceId: "ws_1",
      completionOwner: "workflow",
    });
    expect(store.listTaskAgents(task.id)[0]?.completionOwner).toBe("workflow");

    store.attachAgent({
      taskId: task.id,
      agentId: "agt_1",
      workspaceId: "ws_1",
      completionOwner: "attachment",
    });
    expect(store.listTaskAgents(task.id)[0]?.completionOwner).toBe("attachment");
  });

  it("counts comments on the task and carries their agent authorship", () => {
    const task = store.createTask({ projectId, title: "Discussed" });
    store.createComment({
      projectId,
      taskId: task.id,
      kind: "user",
      authorName: "me",
      body: "why?",
    });
    store.createComment({
      projectId,
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

  it("persists the typed event behind system feed prose", () => {
    const task = store.createTask({ projectId, title: "Moved" });
    store.createComment({
      projectId,
      taskId: task.id,
      kind: "system",
      authorName: "board",
      body: "Moved to Working.",
      entryKind: "system_event",
      event: {
        kind: "task_moved",
        taskId: task.id,
        previousStatus: "todo",
        status: "in_progress",
        cause: "agent attached",
      },
    });

    expect(store.listComments(task.id)[0]?.event).toEqual({
      kind: "task_moved",
      taskId: task.id,
      previousStatus: "todo",
      status: "in_progress",
      cause: "agent attached",
    });
  });

  it("marks interrupted message delivery as failed", () => {
    const task = store.createTask({ projectId, title: "Message" });
    store.createComment({
      projectId,
      taskId: task.id,
      kind: "user",
      authorName: "me",
      body: "Please continue",
      entryKind: "message",
      recipients: [{ agentId: "agt_1", workspaceId: "ws_1", deliveryStatus: "pending" }],
    });

    expect(store.markPendingMessageDeliveriesFailed()).toBe(1);
    expect(store.listComments(task.id)[0]?.recipients).toEqual([
      { agentId: "agt_1", workspaceId: "ws_1", deliveryStatus: "failed" },
    ]);
  });

  it("hangs an attachment off either a task or a comment, never both", () => {
    const task = store.createTask({ projectId, title: "Attached" });
    const comment = store.createComment({
      projectId,
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
    store.createComment({ projectId, taskId: task.id, kind: "user", authorName: "me", body: "hi" });
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
      modeId: "bypassPermissions",
      thinkingOptionId: "high",
      featureValues: { fast_mode: true },
      environmentKind: "new_worktree",
      baseBranch: "main",
    });

    expect(store.getPreset(preset.id)?.model).toBe("opus");
    expect(store.getPreset(preset.id)).toMatchObject({
      modeId: "bypassPermissions",
      thinkingOptionId: "high",
      featureValues: { fast_mode: true },
    });
    expect(store.listPresets().map((entry) => entry.name)).toEqual(["Reviewer"]);
    expect(() =>
      store.createPreset({
        name: "reviewer",
        provider: "codex",
        environmentKind: "project_default",
      }),
    ).toThrow('A task preset named "reviewer" already exists');
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
    const first = await openTaskStore({ databasePath, logger });
    const projectId = first.createProject({ name: "Paseo", prefix: "PSE", color: "#fff" }).id;
    first.createTask({ projectId, title: "Before the change" });
    first.close();

    const raw = new DatabaseSync(databasePath);
    raw.exec("ALTER TABLE tasks RENAME COLUMN priority TO importance");
    raw.close();

    const second = await openTaskStore({ databasePath, logger });
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
    const store = await openTaskStore({ databasePath: join(directory, "tasks.db"), logger });
    try {
      const project = store.createProject({ name: "Paseo", prefix: "PSE", color: "#fff" });
      expect(project.board).toEqual({
        reviewEnabled: false,
        reviewOnReject: "in_progress",
        archiveWorkspacesOnDone: false,
        reviewerPresetId: null,
        maxReviewIterations: 3,
      });
      expect(store.getProject(project.id)?.board).toEqual(project.board);
    } finally {
      store.close();
    }
  });

  it("keeps board settings the caller did not touch", async () => {
    const store = await openTaskStore({ databasePath: join(directory, "tasks.db"), logger });
    try {
      const project = store.createProject({ name: "Paseo", prefix: "PSE", color: "#fff" });
      store.configureBoard({ projectId: project.id, reviewOnReject: "backlog" });
      const configured = store.configureBoard({ projectId: project.id, reviewEnabled: true });
      expect(configured.board).toEqual({
        reviewEnabled: true,
        reviewOnReject: "backlog",
        archiveWorkspacesOnDone: false,
        reviewerPresetId: null,
        maxReviewIterations: 3,
      });
    } finally {
      store.close();
    }
  });

  it("replaces a task's workflow rather than accumulating them", async () => {
    const store = await openTaskStore({ databasePath: join(directory, "tasks.db"), logger });
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
    const store = await openTaskStore({ databasePath: join(directory, "tasks.db"), logger });
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
    const store = await openTaskStore({ databasePath: join(directory, "tasks.db"), logger });
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
  /** One order for the whole board: a note typed at the board and a comment on a
   * card are the same kind of entry, and the feed is where they meet. */
  it("merges card comments and board entries into one feed", async () => {
    const store = await openTaskStore({ databasePath: join(directory, "tasks.db"), logger });
    try {
      const projectId = store.createProject({ name: "Paseo", prefix: "PSE", color: "#fff" }).id;
      const task = store.createTask({ projectId, title: "Ship it" });

      store.createComment({
        projectId,
        taskId: task.id,
        kind: "user",
        authorName: "user",
        body: "on the card",
      });
      store.createComment({ projectId, kind: "system", authorName: "board", body: "at the board" });

      const feed = store.listBoardFeed({ projectId });
      expect(feed.map((entry) => entry.body)).toEqual(["on the card", "at the board"]);
      expect(feed[0].taskId).toBe(task.id);
      expect(feed[1].taskId).toBeNull();
      expect(store.listComments(task.id).map((entry) => entry.body)).toEqual(["on the card"]);
    } finally {
      store.close();
    }
  });

  /** The cap reads back from the newest, so a busy board shows what just
   * happened rather than the day it opened. */
  it("caps the feed at the newest entries and still returns them oldest-first", async () => {
    const store = await openTaskStore({ databasePath: join(directory, "tasks.db"), logger });
    try {
      const projectId = store.createProject({ name: "Paseo", prefix: "PSE", color: "#fff" }).id;
      for (let index = 0; index < 205; index++) {
        store.createComment({
          projectId,
          kind: "user",
          authorName: "user",
          body: `entry ${index}`,
        });
      }
      const feed = store.listBoardFeed({ projectId, limit: 500 });
      expect(feed).toHaveLength(200);
      expect(feed[0]?.body).toBe("entry 5");
      expect(feed.at(-1)?.body).toBe("entry 204");
    } finally {
      store.close();
    }
  });

  it("keeps a board entry when the card it was about is deleted", async () => {
    const store = await openTaskStore({ databasePath: join(directory, "tasks.db"), logger });
    try {
      const projectId = store.createProject({ name: "Paseo", prefix: "PSE", color: "#fff" }).id;
      const task = store.createTask({ projectId, title: "Ship it" });
      store.createComment({
        projectId,
        taskId: task.id,
        kind: "system",
        authorName: "board",
        body: "moved to done",
      });
      store.createComment({ projectId, kind: "user", authorName: "user", body: "board note" });

      store.deleteTask(task.id);

      expect(store.listBoardFeed({ projectId }).map((entry) => entry.body)).toEqual(["board note"]);
    } finally {
      store.close();
    }
  });
});
