import { describe, expect, it } from "vitest";
import { KanbanPlanSchema, StoredKanbanSchema } from "./types.js";

function baseStep() {
  return {
    id: "stp_00000001",
    name: "Build",
    prompt: "Run the build",
    agents: [{ provider: "claude" }],
    completion: "all" as const,
    workspace: { mode: "worktree" as const },
    trigger: { type: "immediate" as const },
    runs: [],
  };
}

function basePlanFields() {
  return {
    id: "pln_00000001",
    title: "Ship the feature",
    description: null,
    createdAt: "2026-08-06T00:00:00.000Z",
    updatedAt: "2026-08-06T00:00:00.000Z",
    archivedAt: null,
    lastMove: null,
  };
}

describe("KanbanPlanSchema", () => {
  it("parses a workflow plan", () => {
    const plan = {
      ...basePlanFields(),
      body: { type: "workflow" as const, steps: [baseStep()] },
    };

    expect(KanbanPlanSchema.parse(plan)).toEqual(plan);
  });

  it("parses a nested_kanban plan whose children are workflow-only", () => {
    const plan = {
      ...basePlanFields(),
      body: {
        type: "nested_kanban" as const,
        columns: [
          {
            id: "col_00000001",
            name: "Backlog",
            role: "backlog" as const,
            onCardEnter: "none" as const,
            archiveWorkspacesOnEnter: false,
            planIds: ["pln_00000002"],
          },
        ],
        plans: {
          pln_00000002: {
            ...basePlanFields(),
            id: "pln_00000002",
            body: { type: "workflow" as const, steps: [] },
          },
        },
      },
    };

    expect(KanbanPlanSchema.parse(plan)).toEqual(plan);
  });

  it("rejects a nested_kanban whose child plan is itself a nested_kanban (depth 3)", () => {
    const plan = {
      ...basePlanFields(),
      body: {
        type: "nested_kanban" as const,
        columns: [],
        plans: {
          pln_00000002: {
            ...basePlanFields(),
            id: "pln_00000002",
            body: {
              type: "nested_kanban",
              columns: [],
              plans: {},
            },
          },
        },
      },
    };

    expect(() => KanbanPlanSchema.parse(plan)).toThrow();
  });
});

describe("StoredKanbanSchema", () => {
  it("parses a kanban with an orchestrator pointer and lastMove on a plan", () => {
    const kanban = {
      id: "kbn_00000001",
      projectId: "prj_00000001",
      name: "Widgets",
      autoAdvance: true,
      orchestrator: { workspaceId: "ws_1", agentId: "agent_1" },
      columns: [
        {
          id: "col_00000001",
          name: "In progress",
          role: "active" as const,
          onCardEnter: "start" as const,
          archiveWorkspacesOnEnter: false,
          planIds: ["pln_00000001"],
        },
      ],
      plans: {
        pln_00000001: {
          ...basePlanFields(),
          lastMove: { at: "2026-08-06T00:00:00.000Z", by: "agent" as const },
          body: { type: "workflow" as const, steps: [baseStep()] },
        },
      },
      createdAt: "2026-08-06T00:00:00.000Z",
      updatedAt: "2026-08-06T00:00:00.000Z",
      archivedAt: null,
    };

    expect(StoredKanbanSchema.parse(kanban)).toEqual(kanban);
  });
});
