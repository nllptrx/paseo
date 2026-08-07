import { describe, expect, it } from "vitest";
import type {
  KanbanPlan,
  Step,
  StepRun,
  StepRunStatus,
  StoredKanban,
} from "@getpaseo/protocol/kanban/types";
import {
  applyOptimisticDispatch,
  deriveBoard,
  resolveBoardDrop,
  retainPendingDispatches,
} from "./derive-board";

function run(status: StepRunStatus): StepRun {
  return {
    id: `run-${status}`,
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: status === "running" ? null : "2026-01-01T00:01:00.000Z",
    status,
    agentIds: [],
    workspaceIds: [],
    scheduleId: null,
    error: null,
  };
}

function step(name: string, runs: StepRun[]): Step {
  return {
    id: `step-${name}`,
    name,
    prompt: name,
    agents: [{ provider: "claude" }],
    completion: "all",
    workspace: { mode: "worktree" },
    trigger: { type: "manual" },
    runs,
  };
}

function plan(id: string, steps: Step[], updatedAt = "2026-01-01T00:00:00.000Z"): KanbanPlan {
  return {
    id,
    title: id,
    description: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt,
    archivedAt: null,
    body: { type: "workflow", steps },
  };
}

function kanban(plans: KanbanPlan[]): StoredKanban {
  return {
    id: "kbn1",
    projectId: "prj1",
    name: "Board",
    archiveWorkspacesOnDone: false,
    plans: Object.fromEntries(plans.map((entry) => [entry.id, entry])),
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    archivedAt: null,
  };
}

function summarizeColumn(column: { key: string; plans: KanbanPlan[] }): [string, string[]] {
  return [column.key, column.plans.map((entry) => entry.id)];
}

describe("deriveBoard", () => {
  it("splits plans across the three derived columns", () => {
    const board = deriveBoard(
      kanban([
        plan("draft-1", [step("a", [])]),
        plan("running-1", [step("a", [run("running")])]),
        plan("done-1", [step("a", [run("succeeded")])]),
      ]),
      [],
    );
    expect(board.columns.map(summarizeColumn)).toEqual([
      ["draft", ["draft-1"]],
      ["inProgress", ["running-1"]],
      ["done", ["done-1"]],
    ]);
    expect(board.totalCount).toBe(3);
  });

  it("omits archived plans", () => {
    const archived = { ...plan("gone", [step("a", [])]), archivedAt: "2026-01-02T00:00:00.000Z" };
    const board = deriveBoard(kanban([archived]), []);
    expect(board.totalCount).toBe(0);
  });

  it("orders drafts by the stored draft order, appending unknown plans by recency", () => {
    const board = deriveBoard(
      kanban([
        plan("a", [step("s", [])], "2026-01-01T00:00:01.000Z"),
        plan("b", [step("s", [])], "2026-01-01T00:00:03.000Z"),
        plan("c", [step("s", [])], "2026-01-01T00:00:02.000Z"),
      ]),
      ["c", "a"],
    );
    expect(board.columns[0]?.plans.map((entry) => entry.id)).toEqual(["c", "a", "b"]);
  });

  it("orders the running and done columns by recency", () => {
    const board = deriveBoard(
      kanban([
        plan("old", [step("s", [run("running")])], "2026-01-01T00:00:01.000Z"),
        plan("new", [step("s", [run("running")])], "2026-01-01T00:00:09.000Z"),
      ]),
      [],
    );
    expect(board.columns[1]?.plans.map((entry) => entry.id)).toEqual(["new", "old"]);
  });
});

describe("resolveBoardDrop", () => {
  const board = deriveBoard(
    kanban([
      plan("d1", [step("s", [])], "2026-01-01T00:00:03.000Z"),
      plan("d2", [step("s", [])], "2026-01-01T00:00:02.000Z"),
      plan("r1", [step("s", [run("running")])]),
    ]),
    ["d1", "d2"],
  );

  it("treats a draft dropped on the running column as a run request", () => {
    expect(
      resolveBoardDrop({ board, activePlanId: "d1", targetColumn: "inProgress", overPlanId: null }),
    ).toEqual({ kind: "run", planId: "d1" });
  });

  it("reports the done column as derived instead of moving the card", () => {
    expect(
      resolveBoardDrop({ board, activePlanId: "d1", targetColumn: "done", overPlanId: null }),
    ).toEqual({ kind: "derived-column" });
  });

  it("reorders within draft", () => {
    expect(
      resolveBoardDrop({ board, activePlanId: "d1", targetColumn: "draft", overPlanId: "d2" }),
    ).toEqual({ kind: "reorderDraft", order: ["d2", "d1"] });
  });

  it("ignores a drop on the card itself", () => {
    expect(
      resolveBoardDrop({ board, activePlanId: "d1", targetColumn: "draft", overPlanId: "d1" }),
    ).toEqual({ kind: "none" });
  });

  it("ignores drags that did not start in draft", () => {
    expect(
      resolveBoardDrop({ board, activePlanId: "r1", targetColumn: "draft", overPlanId: "d1" }),
    ).toEqual({ kind: "none" });
  });
});

describe("applyOptimisticDispatch", () => {
  const board = deriveBoard(
    kanban([
      plan("d1", [step("a", [])]),
      plan("d2", [step("b", [])]),
      plan("r1", [step("c", [run("running")])]),
    ]),
    ["d1", "d2"],
  );

  function idsIn(target: ReturnType<typeof deriveBoard>, key: string): string[] {
    return (target.columns.find((column) => column.key === key)?.plans ?? []).map(
      (entry) => entry.id,
    );
  }

  it("moves a pending draft to the head of the running column", () => {
    const optimistic = applyOptimisticDispatch(board, ["d2"]);

    expect(idsIn(optimistic, "draft")).toEqual(["d1"]);
    expect(idsIn(optimistic, "inProgress")).toEqual(["d2", "r1"]);
  });

  it("returns the board untouched when nothing is pending or the id is unknown", () => {
    expect(applyOptimisticDispatch(board, [])).toBe(board);
    expect(applyOptimisticDispatch(board, ["nope"])).toBe(board);
  });

  it("leaves the count alone — the plan moved, it was not duplicated", () => {
    expect(applyOptimisticDispatch(board, ["d1", "d2"]).totalCount).toBe(board.totalCount);
  });
});

describe("retainPendingDispatches", () => {
  const board = deriveBoard(
    kanban([plan("d1", [step("a", [])]), plan("r1", [step("c", [run("running")])])]),
    ["d1"],
  );

  it("keeps an id whose plan is still a draft", () => {
    expect(retainPendingDispatches(board, ["d1"])).toEqual(["d1"]);
  });

  it("drops an id whose plan has started, or gone", () => {
    expect(retainPendingDispatches(board, ["r1", "gone"])).toEqual([]);
  });
});
