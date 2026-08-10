import { describe, expect, it } from "vitest";
import type { TaskExecutionEntry, TaskExecutionSummary } from "./task-execution";
import { canStartTaskReview } from "./task-execution";
import {
  buildTaskThreadGroups,
  countTaskThreads,
  type TaskThreadTaskSource,
} from "./task-threads-view";

const UNTRACKED_TITLE = "Untracked work";
const PROJECTS = new Map([["prj-1", { prefix: "PSE" }]]);

function task(overrides: Partial<TaskThreadTaskSource> = {}): TaskThreadTaskSource {
  return {
    id: "task-1",
    projectId: "prj-1",
    number: 1,
    title: "One",
    status: "in_progress",
    ...overrides,
  };
}

function entry(overrides: Partial<TaskExecutionEntry> = {}): TaskExecutionEntry {
  return {
    agentId: "agent-1",
    workspaceId: "workspace-1",
    provider: "codex",
    model: null,
    title: null,
    role: "worker",
    state: "running",
    workspaceName: "Workspace",
    branch: null,
    pullRequestNumber: null,
    updatedAtMs: 1_000,
    ...overrides,
  };
}

function summary(entries: TaskExecutionEntry[]): TaskExecutionSummary {
  return {
    totalCount: entries.length,
    counts: {
      needs_input: 0,
      failed: 0,
      starting: 0,
      running: 0,
      attention: 0,
      step_complete: 0,
      done: 0,
    },
    entries,
  };
}

describe("buildTaskThreadGroups", () => {
  it("groups threads by task, keyed and titled from the tracker", () => {
    const groups = buildTaskThreadGroups({
      tasks: [task({ id: "task-1", number: 42, title: "Ship it" })],
      projectsById: PROJECTS,
      executionByTaskId: new Map([["task-1", summary([entry({ agentId: "agent-1" })])]]),
      untracked: [],
      untrackedTitle: UNTRACKED_TITLE,
    });

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      taskId: "task-1",
      taskKey: "PSE-42",
      title: "Ship it",
      status: "in_progress",
      latestUpdateAtMs: 1_000,
    });
    expect(countTaskThreads(groups)).toBe(1);
  });

  it("drops tasks with no attached agent", () => {
    const groups = buildTaskThreadGroups({
      tasks: [task({ id: "task-1" }), task({ id: "task-2" })],
      projectsById: PROJECTS,
      executionByTaskId: new Map([["task-2", summary([entry()])]]),
      untracked: [],
      untrackedTitle: UNTRACKED_TITLE,
    });

    expect(groups.map((group) => group.taskId)).toEqual(["task-2"]);
  });

  it("orders rows and groups by newest activity first", () => {
    const groups = buildTaskThreadGroups({
      tasks: [task({ id: "stale" }), task({ id: "fresh" })],
      projectsById: PROJECTS,
      executionByTaskId: new Map([
        ["stale", summary([entry({ agentId: "old", updatedAtMs: 10 })])],
        [
          "fresh",
          summary([
            entry({ agentId: "middle", updatedAtMs: 50 }),
            entry({ agentId: "newest", updatedAtMs: 90 }),
          ]),
        ],
      ]),
      untracked: [],
      untrackedTitle: UNTRACKED_TITLE,
    });

    expect(groups.map((group) => group.taskId)).toEqual(["fresh", "stale"]);
    expect(groups[0]?.rows.map((row) => row.agentId)).toEqual(["newest", "middle"]);
  });

  it("sorts rows without a timestamp behind the ones that have one", () => {
    const groups = buildTaskThreadGroups({
      tasks: [task({ id: "task-1" })],
      projectsById: PROJECTS,
      executionByTaskId: new Map([
        [
          "task-1",
          summary([
            entry({ agentId: "unknown", updatedAtMs: null }),
            entry({ agentId: "known", updatedAtMs: 5 }),
          ]),
        ],
      ]),
      untracked: [],
      untrackedTitle: UNTRACKED_TITLE,
    });

    expect(groups[0]?.rows.map((row) => row.agentId)).toEqual(["known", "unknown"]);
  });

  it("keeps the untracked group last however fresh it is", () => {
    const groups = buildTaskThreadGroups({
      tasks: [task({ id: "task-1" })],
      projectsById: PROJECTS,
      executionByTaskId: new Map([["task-1", summary([entry({ updatedAtMs: 10 })])]]),
      untracked: [entry({ agentId: "loose", updatedAtMs: 9_999 })],
      untrackedTitle: UNTRACKED_TITLE,
    });

    expect(groups.map((group) => group.id)).toEqual(["task-1", "untracked"]);
    expect(groups[1]).toMatchObject({ taskId: null, taskKey: null, title: UNTRACKED_TITLE });
  });

  it("omits the untracked group when nothing is unclaimed", () => {
    const groups = buildTaskThreadGroups({
      tasks: [],
      projectsById: new Map(),
      executionByTaskId: new Map(),
      untracked: [],
      untrackedTitle: UNTRACKED_TITLE,
    });

    expect(groups).toEqual([]);
  });
});

describe("canStartTaskReview", () => {
  it("offers the gesture on a review with no reviewer at all", () => {
    expect(canStartTaskReview({ status: "in_review", entries: [entry({ role: "worker" })] })).toBe(
      true,
    );
  });

  it("offers it again once the reviewer has settled", () => {
    expect(
      canStartTaskReview({
        status: "in_review",
        entries: [entry({ role: "reviewer", state: "attention" })],
      }),
    ).toBe(true);
    expect(
      canStartTaskReview({
        status: "in_review",
        entries: [entry({ role: "reviewer", state: "done" })],
      }),
    ).toBe(true);
    expect(
      canStartTaskReview({
        status: "in_review",
        entries: [entry({ role: "reviewer", state: "failed" })],
      }),
    ).toBe(true);
  });

  it("withholds it while a reviewer can still deliver a verdict", () => {
    for (const state of ["running", "starting", "needs_input"] as const) {
      expect(
        canStartTaskReview({
          status: "in_review",
          entries: [entry({ role: "reviewer", state })],
        }),
      ).toBe(false);
    }
  });

  it("withholds it outside review", () => {
    expect(canStartTaskReview({ status: "in_progress", entries: [] })).toBe(false);
    expect(canStartTaskReview({ status: "done", entries: [] })).toBe(false);
  });
});
