import { describe, expect, it } from "vitest";
import type { StoredKanban } from "@getpaseo/protocol/kanban/types";
import { applyTopLevelPlanMove, resolveBoardPlanDrop } from "./apply-plan-move";

const columns = [
  { id: "col-a", planIds: ["p1", "p2", "p3"] },
  { id: "col-b", planIds: ["p4"] },
  { id: "col-c", planIds: [] as string[] },
];

describe("resolveBoardPlanDrop", () => {
  it("reorders within a column to the over plan index", () => {
    expect(resolveBoardPlanDrop({ columns, planId: "p1", overId: "p3" })).toEqual({
      planId: "p1",
      columnId: "col-a",
      index: 2,
    });
  });

  it("moves across columns onto a plan", () => {
    expect(resolveBoardPlanDrop({ columns, planId: "p1", overId: "p4" })).toEqual({
      planId: "p1",
      columnId: "col-b",
      index: 0,
    });
  });

  it("appends when dropping on a column body", () => {
    expect(resolveBoardPlanDrop({ columns, planId: "p1", overId: "column:col-b" })).toEqual({
      planId: "p1",
      columnId: "col-b",
      index: 1,
    });
  });

  it("drops into an empty column at index 0", () => {
    expect(resolveBoardPlanDrop({ columns, planId: "p2", overId: "column:col-c" })).toEqual({
      planId: "p2",
      columnId: "col-c",
      index: 0,
    });
  });

  it("returns null when dropping on itself", () => {
    expect(resolveBoardPlanDrop({ columns, planId: "p1", overId: "p1" })).toBeNull();
  });
});

describe("applyTopLevelPlanMove", () => {
  const baseKanban = {
    id: "kbn1",
    projectId: "prj1",
    name: "Board",
    autoAdvance: false,
    orchestrator: null,
    columns: [
      {
        id: "col-a",
        name: "A",
        role: "backlog" as const,
        onCardEnter: "none" as const,
        archiveWorkspacesOnEnter: false,
        planIds: ["p1", "p2"],
      },
      {
        id: "col-b",
        name: "B",
        role: "active" as const,
        onCardEnter: "none" as const,
        archiveWorkspacesOnEnter: false,
        planIds: ["p3"],
      },
    ],
    plans: {
      p1: {
        id: "p1",
        title: "One",
        description: null,
        createdAt: "t0",
        updatedAt: "t0",
        archivedAt: null,
        lastMove: null,
        body: {
          type: "workflow" as const,
          steps: [],
        },
      },
      p2: {
        id: "p2",
        title: "Two",
        description: null,
        createdAt: "t0",
        updatedAt: "t0",
        archivedAt: null,
        lastMove: null,
        body: {
          type: "workflow" as const,
          steps: [],
        },
      },
      p3: {
        id: "p3",
        title: "Three",
        description: null,
        createdAt: "t0",
        updatedAt: "t0",
        archivedAt: null,
        lastMove: null,
        body: {
          type: "workflow" as const,
          steps: [],
        },
      },
    },
    createdAt: "t0",
    updatedAt: "t0",
    archivedAt: null,
  } satisfies StoredKanban;

  it("moves a plan across columns", () => {
    const next = applyTopLevelPlanMove(baseKanban, {
      planId: "p1",
      columnId: "col-b",
      index: 0,
    });
    expect(next?.columns.find((column) => column.id === "col-a")?.planIds).toEqual(["p2"]);
    expect(next?.columns.find((column) => column.id === "col-b")?.planIds).toEqual(["p1", "p3"]);
    expect(next?.plans.p1.lastMove?.by).toBe("user");
  });

  it("reorders within a column", () => {
    const next = applyTopLevelPlanMove(baseKanban, {
      planId: "p1",
      columnId: "col-a",
      index: 1,
    });
    expect(next?.columns.find((column) => column.id === "col-a")?.planIds).toEqual(["p2", "p1"]);
  });
});
