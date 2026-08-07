import { describe, expect, it } from "vitest";
import type { Task, TaskLabel, TaskProject } from "@getpaseo/protocol/tasks/types";
import {
  ALL_TASK_HOSTS_FAILED_MESSAGE,
  fetchAggregatedTaskBoards,
  findBoardById,
  splitSnapshotIntoBoards,
  type TaskBoardRuntime,
} from "./aggregated-task-boards";

function project(id: string, overrides: Partial<TaskProject> = {}): TaskProject {
  return {
    id,
    name: `Project ${id}`,
    prefix: id.toUpperCase(),
    color: "#fff",
    paseoProjectId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function task(id: string, projectId: string): Task {
  return {
    id,
    projectId,
    number: 1,
    title: `Task ${id}`,
    description: "",
    status: "todo",
    priority: "none",
    dueDate: null,
    parentTaskId: null,
    position: 1024,
    labelIds: [],
    agents: [],
    attachments: [],
    commentCount: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function label(id: string, projectId: string): TaskLabel {
  return { id, projectId, name: id, color: "#fff" };
}

const host = { serverId: "srv-1", serverName: "Local", supportsTasks: true };

function runtimeWith(
  handlers: Record<string, { status: string; snapshot?: () => Promise<unknown> }>,
): TaskBoardRuntime {
  return {
    getSnapshot: (serverId) =>
      handlers[serverId] ? { connectionStatus: handlers[serverId].status } : undefined,
    getClient: (serverId) => {
      const handler = handlers[serverId];
      if (!handler?.snapshot) {
        return null;
      }
      return { tasksSnapshot: handler.snapshot } as never;
    },
  };
}

describe("splitSnapshotIntoBoards", () => {
  it("gives each project only its own tasks and labels", () => {
    const boards = splitSnapshotIntoBoards(
      {
        projects: [project("a"), project("b")],
        tasks: [task("t1", "a"), task("t2", "b"), task("t3", "a")],
        labels: [label("l1", "b")],
      },
      host,
    );

    expect(boards.map((board) => board.project.id)).toEqual(["a", "b"]);
    expect(boards[0].tasks.map((entry) => entry.id)).toEqual(["t1", "t3"]);
    expect(boards[0].labels).toEqual([]);
    expect(boards[1].labels.map((entry) => entry.id)).toEqual(["l1"]);
  });
});

describe("fetchAggregatedTaskBoards", () => {
  it("skips offline hosts and merges the rest", async () => {
    const result = await fetchAggregatedTaskBoards({
      hosts: [host, { serverId: "srv-2", serverName: "Offline", supportsTasks: true }],
      runtime: runtimeWith({
        "srv-1": {
          status: "online",
          snapshot: async () => ({
            snapshot: {
              revision: 1,
              projects: [project("a")],
              tasks: [task("t1", "a")],
              labels: [],
            },
            error: null,
          }),
        },
        "srv-2": { status: "offline" },
      }),
    });

    expect(result.status).toBe("loaded");
    if (result.status !== "loaded") return;
    expect(result.data).toHaveLength(1);
    expect(result.hostErrors).toEqual([]);
  });

  /** One broken host must not blank the boards the others answered for. */
  it("reports a failing host without dropping the hosts that answered", async () => {
    const result = await fetchAggregatedTaskBoards({
      hosts: [host, { serverId: "srv-2", serverName: "Broken", supportsTasks: true }],
      runtime: runtimeWith({
        "srv-1": {
          status: "online",
          snapshot: async () => ({
            snapshot: { revision: 1, projects: [project("a")], tasks: [], labels: [] },
            error: null,
          }),
        },
        "srv-2": {
          status: "online",
          snapshot: async () => ({ snapshot: null, error: "tracker is unavailable" }),
        },
      }),
    });

    expect(result.status).toBe("loaded");
    if (result.status !== "loaded") return;
    expect(result.data.map((board) => board.project.id)).toEqual(["a"]);
    expect(result.hostErrors.map((entry) => entry.serverId)).toEqual(["srv-2"]);
  });

  it("throws when every connected host fails", async () => {
    await expect(
      fetchAggregatedTaskBoards({
        hosts: [host],
        runtime: runtimeWith({
          "srv-1": {
            status: "online",
            snapshot: async () => {
              throw new Error("boom");
            },
          },
        }),
      }),
    ).rejects.toThrow(ALL_TASK_HOSTS_FAILED_MESSAGE);
  });

  /** A daemon without a tracker is not a failure to report; it simply has no
   * boards, and asking it would only produce an error banner. */
  it("skips a host that has no tracker instead of failing it", async () => {
    let asked = false;
    const result = await fetchAggregatedTaskBoards({
      hosts: [{ serverId: "srv-1", serverName: "No tracker", supportsTasks: false }],
      runtime: runtimeWith({
        "srv-1": {
          status: "online",
          snapshot: async () => {
            asked = true;
            throw new Error("tasks are unavailable on this host");
          },
        },
      }),
    });

    expect(asked).toBe(false);
    expect(result).toEqual({ status: "loaded", data: [], hostErrors: [] });
  });

  it("stays connecting while a host has not settled", async () => {
    const result = await fetchAggregatedTaskBoards({
      hosts: [host],
      runtime: runtimeWith({ "srv-1": { status: "connecting" } }),
    });
    expect(result.status).toBe("connecting");
  });
});

describe("findBoardById", () => {
  it("returns null rather than guessing when the id is not loaded", () => {
    const boards = splitSnapshotIntoBoards(
      { projects: [project("a")], tasks: [], labels: [] },
      host,
    );
    expect(findBoardById(boards, "a")?.project.id).toBe("a");
    expect(findBoardById(boards, "missing")).toBeNull();
  });
});
