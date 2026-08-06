import { describe, expect, it } from "vitest";
import type { KanbanPlan, NestedPlan, Step, StepRun, StepRunStatus } from "./types.js";
import { derivePlanColumn, derivePlanRunState, resolveNextRunnableStepId } from "./derive.js";

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
    lastMove: null,
    body: { type: "workflow", steps },
  };
}

function childPlan(id: string, steps: Step[]): NestedPlan {
  return { ...plan(id, steps), body: { type: "workflow", steps } };
}

describe("derivePlanRunState", () => {
  it("is idle when no step has run", () => {
    expect(derivePlanRunState(plan("p", [step("a", []), step("b", [])]))).toBe("idle");
  });

  it("is idle for a plan with no steps at all", () => {
    expect(derivePlanRunState(plan("p", []))).toBe("idle");
  });

  it("is running while a step run is open", () => {
    expect(derivePlanRunState(plan("p", [step("a", [run("running")])]))).toBe("running");
  });

  it("is running when an earlier step succeeded but later steps have not started", () => {
    expect(derivePlanRunState(plan("p", [step("a", [run("succeeded")]), step("b", [])]))).toBe(
      "running",
    );
  });

  it("is done when every step settled successfully", () => {
    expect(
      derivePlanRunState(plan("p", [step("a", [run("succeeded")]), step("b", [run("skipped")])])),
    ).toBe("done");
  });

  it("is failed when a settled step did not succeed", () => {
    expect(
      derivePlanRunState(plan("p", [step("a", [run("succeeded")]), step("b", [run("failed")])])),
    ).toBe("failed");
  });

  it("reads only the latest run, so a retry supersedes an earlier failure", () => {
    expect(derivePlanRunState(plan("p", [step("a", [run("failed"), run("succeeded")])]))).toBe(
      "done",
    );
  });

  it("aggregates a nested kanban's child steps", () => {
    const nested: KanbanPlan = {
      ...plan("nested", []),
      body: {
        type: "nested_kanban",
        columns: [],
        plans: { child: childPlan("child", [step("a", [run("running")])]) },
      },
    };
    expect(derivePlanRunState(nested)).toBe("running");
  });
});

describe("derivePlanColumn", () => {
  it("keeps a failed plan in the running column rather than inventing one", () => {
    expect(derivePlanColumn(plan("p", [step("a", [run("failed")])]))).toBe("inProgress");
  });

  it("maps idle to draft and settled to done", () => {
    expect(derivePlanColumn(plan("p", [step("a", [])]))).toBe("draft");
    expect(derivePlanColumn(plan("p", [step("a", [run("succeeded")])]))).toBe("done");
  });
});

describe("resolveNextRunnableStepId", () => {
  it("starts at the first step of an untouched plan", () => {
    expect(resolveNextRunnableStepId(plan("p", [step("a", []), step("b", [])]))).toBe("step-a");
  });

  it("resumes at the first unsettled step", () => {
    expect(
      resolveNextRunnableStepId(plan("p", [step("a", [run("succeeded")]), step("b", [])])),
    ).toBe("step-b");
  });

  it("re-runs a failed step rather than moving past it", () => {
    expect(resolveNextRunnableStepId(plan("p", [step("a", [run("failed")]), step("b", [])]))).toBe(
      "step-a",
    );
  });

  it("refuses while a step is already running, so a second request cannot queue a turn", () => {
    expect(
      resolveNextRunnableStepId(plan("p", [step("a", [run("running")]), step("b", [])])),
    ).toBeNull();
  });

  it("is null once every step has settled", () => {
    expect(resolveNextRunnableStepId(plan("p", [step("a", [run("succeeded")])]))).toBeNull();
  });

  it("is null for a nested kanban, whose children run on their own board", () => {
    const nested: KanbanPlan = {
      ...plan("nested", []),
      body: { type: "nested_kanban", plans: {} },
    };
    expect(resolveNextRunnableStepId(nested)).toBeNull();
  });
});
