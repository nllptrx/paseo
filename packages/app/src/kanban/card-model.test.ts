import { describe, expect, it } from "vitest";
import type { KanbanPlan, NestedPlan, Step, StepRun } from "@getpaseo/protocol/kanban/types";
import { derivePlanActiveSince, derivePlanProviders } from "./card-model";

function step(name: string, providers: string[], runs: StepRun[] = []): Step {
  return {
    id: `step-${name}`,
    name,
    prompt: name,
    agents: providers.map((provider) => ({ provider })),
    completion: "all",
    workspace: { mode: "worktree" },
    trigger: { type: "manual" },
    runs,
  };
}

function runningRun(startedAt: string): StepRun {
  return {
    id: `run-${startedAt}`,
    startedAt,
    endedAt: null,
    status: "running",
    agentIds: [],
    workspaceIds: [],
    scheduleId: null,
    error: null,
  };
}

function plan(steps: Step[]): KanbanPlan {
  return {
    id: "p",
    title: "p",
    description: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    archivedAt: null,
    lastMove: null,
    body: { type: "workflow", steps },
  };
}

function childPlan(steps: Step[]): NestedPlan {
  return { ...plan(steps), body: { type: "workflow", steps } };
}

describe("derivePlanProviders", () => {
  it("lists distinct providers in first-use order", () => {
    expect(
      derivePlanProviders(
        plan([step("a", ["claude", "codex"]), step("b", ["codex"]), step("c", ["opencode"])]),
      ),
    ).toEqual(["claude", "codex", "opencode"]);
  });

  it("aggregates a nested kanban's children", () => {
    const nested: KanbanPlan = {
      ...plan([]),
      body: {
        type: "nested_kanban",
        columns: [],
        plans: { child: childPlan([step("a", ["pi"])]) },
      },
    };
    expect(derivePlanProviders(nested)).toEqual(["pi"]);
  });
});

describe("derivePlanActiveSince", () => {
  it("is null when nothing is running", () => {
    expect(derivePlanActiveSince(plan([step("a", ["claude"])]))).toBeNull();
  });

  it("reports the earliest open run, so parallel steps share one elapsed label", () => {
    const since = derivePlanActiveSince(
      plan([
        step("a", ["claude"], [runningRun("2026-01-01T00:05:00.000Z")]),
        step("b", ["codex"], [runningRun("2026-01-01T00:02:00.000Z")]),
      ]),
    );
    expect(since?.toISOString()).toBe("2026-01-01T00:02:00.000Z");
  });
});
