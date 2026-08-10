import type { Task, TaskLabel, TaskPriority, TaskStatus } from "@getpaseo/protocol/tasks/types";
import { describe, expect, it } from "vitest";
import {
  BOARD_STATUSES,
  filterTasks,
  formatTaskKey,
  groupTasksByStatus,
  partitionTaskLabels,
  resolveTaskDropNeighbours,
  resolveTaskLabels,
  sortTasks,
  taskLabelFilterOptions,
  visibleBoardStatuses,
  selectOverviewTasks,
  selectBlockers,
  buildTaskRelationshipSummaries,
  groupSubtasksUnderParents,
} from "./task-views";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    projectId: "prj-1",
    number: 1,
    title: "One",
    description: "",
    status: "backlog",
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
    ...overrides,
  };
}

function label(overrides: Partial<TaskLabel> = {}): TaskLabel {
  return { id: "lbl-1", projectId: "prj-1", name: "bug", color: "#f00", ...overrides };
}

describe("groupTasksByStatus", () => {
  it("returns groups in canonical order regardless of input order", () => {
    const groups = groupTasksByStatus([
      task({ id: "a", status: "done" }),
      task({ id: "b", status: "backlog" }),
      task({ id: "c", status: "in_review" }),
    ]);

    expect(groups.map((group) => group.status)).toEqual(["backlog", "in_review", "done"]);
  });

  it("drops empty groups", () => {
    const groups = groupTasksByStatus([task({ status: "todo" })]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.status).toBe("todo");
  });

  it("keeps the order it was given inside a group", () => {
    const groups = groupTasksByStatus([
      task({ id: "second", status: "todo", position: 2048 }),
      task({ id: "first", status: "todo", position: 1024 }),
    ]);

    expect(groups[0]?.tasks.map((entry) => entry.id)).toEqual(["second", "first"]);
  });
});

describe("visibleBoardStatuses", () => {
  it("hides canceled until something is canceled", () => {
    expect(visibleBoardStatuses([task({ status: "todo" })])).toEqual([...BOARD_STATUSES]);
    expect(visibleBoardStatuses([task({ status: "canceled" })])).toEqual([
      ...BOARD_STATUSES,
      "canceled",
    ]);
  });
});

describe("formatTaskKey", () => {
  it("joins the project prefix to the task number", () => {
    expect(formatTaskKey({ prefix: "PSE" }, { number: 42 })).toBe("PSE-42");
  });

  it("does not pretend to know a prefix it was not given", () => {
    expect(formatTaskKey(undefined, { number: 42 })).toBe("?-42");
  });
});

describe("taskLabelFilterOptions", () => {
  it("collapses labels sharing a name across projects into one option", () => {
    const options = taskLabelFilterOptions([
      label({ id: "l1", projectId: "p1", name: "bug" }),
      label({ id: "l2", projectId: "p2", name: "bug" }),
      label({ id: "l3", projectId: "p1", name: "api" }),
    ]);

    expect(options.map((option) => option.name)).toEqual(["api", "bug"]);
    expect(options[1]?.labelIds).toEqual(["l1", "l2"]);
  });
});

describe("filterTasks", () => {
  const labels = [
    label({ id: "l1", projectId: "p1", name: "bug" }),
    label({ id: "l2", projectId: "p2", name: "bug" }),
  ];
  const tasks = [
    task({ id: "a", projectId: "p1", status: "todo", priority: "high", labelIds: ["l1"] }),
    task({ id: "b", projectId: "p2", status: "done", priority: "low", labelIds: ["l2"] }),
    task({ id: "c", projectId: "p1", status: "todo", priority: "none", labelIds: [] }),
  ];

  it("narrows nothing when every facet is unset", () => {
    expect(filterTasks({ tasks, labels, filters: {} })).toHaveLength(3);
  });

  it("treats an empty selection as unset rather than as nothing matches", () => {
    expect(
      filterTasks({ tasks, labels, filters: { statuses: [], priorities: [], labelNames: [] } }),
    ).toHaveLength(3);
  });

  it("narrows by status, priority and project", () => {
    expect(
      filterTasks({ tasks, labels, filters: { statuses: ["todo"] } }).map((entry) => entry.id),
    ).toEqual(["a", "c"]);
    expect(
      filterTasks({ tasks, labels, filters: { priorities: ["high"] } }).map((entry) => entry.id),
    ).toEqual(["a"]);
    expect(
      filterTasks({ tasks, labels, filters: { projectId: "p2" } }).map((entry) => entry.id),
    ).toEqual(["b"]);
  });

  it("matches a label by name across every project that has one", () => {
    expect(
      filterTasks({ tasks, labels, filters: { labelNames: ["bug"] } }).map((entry) => entry.id),
    ).toEqual(["a", "b"]);
  });

  it("intersects facets rather than uniting them", () => {
    expect(
      filterTasks({
        tasks,
        labels,
        filters: { statuses: ["todo"], labelNames: ["bug"] },
      }).map((entry) => entry.id),
    ).toEqual(["a"]);
  });
});

describe("sortTasks", () => {
  const byPriority: TaskPriority[] = ["low", "urgent", "none", "high", "medium"];
  const tasks = byPriority.map((priority, index) =>
    task({ id: priority, priority, position: index }),
  );

  it("orders manual by position", () => {
    expect(sortTasks(tasks, "manual").map((entry) => entry.id)).toEqual(byPriority);
  });

  it("orders priority urgent first and no-priority last", () => {
    expect(sortTasks(tasks, "priority").map((entry) => entry.id)).toEqual([
      "urgent",
      "high",
      "medium",
      "low",
      "none",
    ]);
  });

  it("sorts a missing due date after every date, not before", () => {
    const dated = [
      task({ id: "none", dueDate: null, position: 0 }),
      task({ id: "late", dueDate: "2026-12-01", position: 1 }),
      task({ id: "soon", dueDate: "2026-01-02", position: 2 }),
    ];

    expect(sortTasks(dated, "due").map((entry) => entry.id)).toEqual(["soon", "late", "none"]);
  });

  it("does not mutate the array it was given", () => {
    const input = [task({ id: "b", position: 2 }), task({ id: "a", position: 1 })];
    sortTasks(input, "manual");
    expect(input.map((entry) => entry.id)).toEqual(["b", "a"]);
  });
});

describe("partitionTaskLabels", () => {
  it("keeps everything when it fits", () => {
    const labels = [label({ id: "l1" }), label({ id: "l2" })];
    expect(partitionTaskLabels(labels, 2)).toEqual({ visible: labels, hidden: [] });
  });

  it("overflows the rest so the row keeps a bounded width", () => {
    const labels = [label({ id: "l1" }), label({ id: "l2" }), label({ id: "l3" })];
    const { visible, hidden } = partitionTaskLabels(labels, 2);
    expect(visible.map((entry) => entry.id)).toEqual(["l1", "l2"]);
    expect(hidden.map((entry) => entry.id)).toEqual(["l3"]);
  });
});

describe("resolveTaskLabels", () => {
  it("skips a label id the snapshot no longer knows", () => {
    const resolved = resolveTaskLabels({ labelIds: ["l1", "gone"] }, [label({ id: "l1" })]);
    expect(resolved.map((entry) => entry.id)).toEqual(["l1"]);
  });
});

describe("buildTaskRelationshipSummaries", () => {
  it("counts subtasks and open blockers without treating settled dependencies as blocked", () => {
    const tasks = [
      task({ id: "parent" }),
      task({ id: "child-1", parentTaskId: "parent" }),
      task({ id: "child-2", parentTaskId: "parent" }),
      task({ id: "open-blocker", status: "in_progress" }),
      task({ id: "done-blocker", status: "done" }),
    ];
    const summaries = buildTaskRelationshipSummaries({
      tasks,
      dependencies: [
        { taskId: "parent", dependsOnTaskId: "open-blocker" },
        { taskId: "parent", dependsOnTaskId: "done-blocker" },
      ],
    });

    expect(summaries.get("parent")).toEqual({ subtaskCount: 2, blockerCount: 1 });
    expect(summaries.get("child-1")).toEqual({ subtaskCount: 0, blockerCount: 0 });
  });
});

describe("resolveTaskDropNeighbours", () => {
  const column = [task({ id: "a", position: 100 }), task({ id: "b", position: 200 })];

  it("reports no neighbour above when dropped at the top", () => {
    expect(resolveTaskDropNeighbours(column, 0)).toEqual({
      beforePosition: null,
      afterPosition: 100,
    });
  });

  it("reports both neighbours when dropped between two cards", () => {
    expect(resolveTaskDropNeighbours(column, 1)).toEqual({
      beforePosition: 100,
      afterPosition: 200,
    });
  });

  it("reports no neighbour below when dropped at the end", () => {
    expect(resolveTaskDropNeighbours(column, 2)).toEqual({
      beforePosition: 200,
      afterPosition: null,
    });
  });

  it("reports an empty column as having no neighbours at all", () => {
    expect(resolveTaskDropNeighbours([], 0)).toEqual({
      beforePosition: null,
      afterPosition: null,
    });
  });

  it("clamps an index past either end instead of reading off the array", () => {
    expect(resolveTaskDropNeighbours(column, 99)).toEqual({
      beforePosition: 200,
      afterPosition: null,
    });
    expect(resolveTaskDropNeighbours(column, -3)).toEqual({
      beforePosition: null,
      afterPosition: 100,
    });
  });
});

describe("status coverage", () => {
  it("keeps the board's column list a subset of the protocol's statuses", () => {
    const statuses: TaskStatus[] = [...BOARD_STATUSES];
    expect(statuses).not.toContain("canceled");
  });
});

describe("selectOverviewTasks", () => {
  function taskAt(id: string, status: TaskStatus, position: number): Task {
    return {
      id,
      projectId: "p1",
      number: 1,
      title: id,
      description: "",
      status,
      priority: "none",
      dueDate: null,
      parentTaskId: null,
      position,
      labelIds: [],
      agents: [],
      attachments: [],
      commentCount: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
  }

  it("puts work in flight before what is queued and what is finished", () => {
    const selection = selectOverviewTasks([
      taskAt("done", "done", 1),
      taskAt("backlog", "backlog", 1),
      taskAt("running", "in_progress", 2),
      taskAt("review", "in_review", 1),
      taskAt("todo", "todo", 1),
    ]);

    expect(selection.tasks.map((entry) => entry.id)).toEqual([
      "running",
      "review",
      "todo",
      "backlog",
      "done",
    ]);
    expect(selection.hiddenCount).toBe(0);
  });

  /** The remainder is counted, not dropped: a column that silently shows 20 of
   * 60 reads as a project with 20 tasks. */
  it("counts what the cap left out", () => {
    const tasks = Array.from({ length: 25 }, (_, index) => taskAt(`t${index}`, "todo", index));
    const selection = selectOverviewTasks(tasks, 20);
    expect(selection.tasks).toHaveLength(20);
    expect(selection.totalCount).toBe(25);
    expect(selection.hiddenCount).toBe(5);
  });
});

describe("selectBlockers", () => {
  function taskWith(id: string, status: TaskStatus): Task {
    return {
      id,
      projectId: "p1",
      number: 1,
      title: id,
      description: "",
      status,
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

  it("ignores blockers that are done or canceled", () => {
    const blockers = selectBlockers({
      taskId: "blocked",
      tasks: [
        taskWith("blocked", "todo"),
        taskWith("open", "in_progress"),
        taskWith("finished", "done"),
        taskWith("dropped", "canceled"),
      ],
      dependencies: [
        { taskId: "blocked", dependsOnTaskId: "open" },
        { taskId: "blocked", dependsOnTaskId: "finished" },
        { taskId: "blocked", dependsOnTaskId: "dropped" },
      ],
    });
    expect(blockers.map((entry) => entry.id)).toEqual(["open"]);
  });
});

describe("groupSubtasksUnderParents", () => {
  function child(id: string, parentTaskId: string | null): Task {
    return {
      id,
      projectId: "p1",
      number: 1,
      title: id,
      description: "",
      status: "todo",
      priority: "none",
      dueDate: null,
      parentTaskId,
      position: 1024,
      labelIds: [],
      agents: [],
      attachments: [],
      commentCount: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
  }

  it("puts children under their parent and nests deeper ones", () => {
    const rows = groupSubtasksUnderParents([
      child("parent", null),
      child("child", "parent"),
      child("grandchild", "child"),
      child("other", null),
    ]);
    expect(rows.map((row) => [row.task.id, row.depth])).toEqual([
      ["parent", 0],
      ["child", 1],
      ["grandchild", 2],
      ["other", 0],
    ]);
  });

  /** A column shows one status, so a child often sits in a column its parent is
   * not in. It has to render as a row of its own there, not disappear. */
  it("treats a child whose parent is not in the column as a root", () => {
    const rows = groupSubtasksUnderParents([child("child", "parent-elsewhere")]);
    expect(rows).toEqual([{ task: rows[0].task, depth: 0 }]);
  });
});
