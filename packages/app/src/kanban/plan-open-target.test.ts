import { describe, expect, it } from "vitest";
import type {
  KanbanPlan,
  NestedPlan,
  Step,
  StepRun,
  StepRunStatus,
} from "@getpaseo/protocol/kanban/types";
import { resolvePlanOpenTarget } from "./plan-open-target";

function run(status: StepRunStatus, agentId: string, workspaceId: string): StepRun {
  return {
    id: `run-${agentId}`,
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: status === "running" ? null : "2026-01-01T00:01:00.000Z",
    status,
    agentIds: [agentId],
    workspaceIds: [workspaceId],
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

function plan(steps: Step[]): KanbanPlan {
  return {
    id: "p",
    title: "p",
    description: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    archivedAt: null,
    body: { type: "workflow", steps },
  };
}

function childPlan(steps: Step[]): NestedPlan {
  return { ...plan(steps), body: { type: "workflow", steps } };
}

describe("resolvePlanOpenTarget", () => {
  it("opens the plan itself when nothing has run", () => {
    expect(resolvePlanOpenTarget(plan([step("a", [])]))).toEqual({ kind: "plan" });
  });

  it("opens the running agent's chat", () => {
    const target = resolvePlanOpenTarget(
      plan([
        step("a", [run("succeeded", "agent-1", "ws-1")]),
        step("b", [run("running", "agent-2", "ws-2")]),
      ]),
    );
    expect(target).toEqual({ kind: "agent", agentId: "agent-2", workspaceId: "ws-2" });
  });

  it("prefers the running step over a later finished one", () => {
    const target = resolvePlanOpenTarget(
      plan([
        step("a", [run("running", "agent-1", "ws-1")]),
        step("b", [run("succeeded", "agent-2", "ws-2")]),
      ]),
    );
    expect(target).toEqual({ kind: "agent", agentId: "agent-1", workspaceId: "ws-1" });
  });

  it("opens the last agent that ran once the plan is finished", () => {
    const target = resolvePlanOpenTarget(
      plan([
        step("a", [run("succeeded", "agent-1", "ws-1")]),
        step("b", [run("succeeded", "agent-2", "ws-2")]),
      ]),
    );
    expect(target).toEqual({ kind: "agent", agentId: "agent-2", workspaceId: "ws-2" });
  });

  it("falls back to the plan when a run recorded no agent", () => {
    const skipped: StepRun = {
      ...run("skipped", "unused", "ws-1"),
      agentIds: [],
      workspaceIds: [],
    };
    expect(resolvePlanOpenTarget(plan([step("a", [skipped])]))).toEqual({ kind: "plan" });
  });

  it("reaches into a nested kanban's children", () => {
    const nested: KanbanPlan = {
      ...plan([]),
      body: {
        type: "nested_kanban",
        plans: { child: childPlan([step("a", [run("running", "agent-9", "ws-9")])]) },
      },
    };
    expect(resolvePlanOpenTarget(nested)).toEqual({
      kind: "agent",
      agentId: "agent-9",
      workspaceId: "ws-9",
    });
  });
});
