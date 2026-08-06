import { describe, expect, it } from "vitest";
import type { KanbanPlan, Step, StepRun, StepRunStatus } from "@getpaseo/protocol/kanban/types";
import { resolveNextRunnableStepId } from "./run-plan";

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

function step(id: string, runs: StepRun[]): Step {
  return {
    id,
    name: id,
    prompt: id,
    agents: [{ provider: "claude" }],
    completion: "all",
    workspace: { mode: "worktree" },
    trigger: { type: "manual" },
    runs,
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

describe("resolveNextRunnableStepId", () => {
  it("starts at the first step of an untouched plan", () => {
    expect(resolveNextRunnableStepId(plan([step("a", []), step("b", [])]))).toBe("a");
  });

  it("resumes at the first unsettled step", () => {
    expect(resolveNextRunnableStepId(plan([step("a", [run("succeeded")]), step("b", [])]))).toBe(
      "b",
    );
  });

  it("treats a skipped step as settled", () => {
    expect(resolveNextRunnableStepId(plan([step("a", [run("skipped")]), step("b", [])]))).toBe("b");
  });

  it("re-runs a failed step rather than moving past it", () => {
    expect(resolveNextRunnableStepId(plan([step("a", [run("failed")]), step("b", [])]))).toBe("a");
  });

  it("refuses while a step is already running, so a second drop cannot queue a turn", () => {
    expect(
      resolveNextRunnableStepId(plan([step("a", [run("running")]), step("b", [])])),
    ).toBeNull();
  });

  it("is null once every step has settled", () => {
    expect(resolveNextRunnableStepId(plan([step("a", [run("succeeded")])]))).toBeNull();
  });

  it("is null for a nested kanban, whose children run on their own board", () => {
    const nested: KanbanPlan = {
      ...plan([]),
      body: { type: "nested_kanban", columns: [], plans: {} },
    };
    expect(resolveNextRunnableStepId(nested)).toBeNull();
  });
});
