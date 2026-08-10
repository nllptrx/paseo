import { describe, expect, it } from "vitest";
import type { Step, StepRun } from "@getpaseo/protocol/tasks/workflow";
import { resolveStepAgentTarget } from "./task-workflow-view";

function run(id: string, agentIds: string[], workspaceIds: string[]): StepRun {
  return {
    id,
    startedAt: "2026-08-10T10:00:00.000Z",
    endedAt: null,
    status: "running",
    agentIds,
    workspaceIds,
    scheduleId: null,
    error: null,
  };
}

function step(runs: StepRun[]): Step {
  return {
    id: "step-1",
    name: "Build",
    prompt: "Build it",
    agents: [{ provider: "codex" }],
    completion: "all",
    workspace: { mode: "worktree" },
    trigger: { type: "manual" },
    runs,
  };
}

describe("resolveStepAgentTarget", () => {
  it("opens the matching agent and workspace from the latest run", () => {
    expect(
      resolveStepAgentTarget(
        step([
          run("old", ["old-agent"], ["old-workspace"]),
          run("current", ["current-agent"], ["current-workspace"]),
        ]),
      ),
    ).toEqual({ agentId: "current-agent", workspaceId: "current-workspace" });
  });

  it("does not offer a chat before a run or without a matching workspace", () => {
    expect(resolveStepAgentTarget(step([]))).toBeNull();
    expect(resolveStepAgentTarget(step([run("broken", ["agent"], [])]))).toBeNull();
  });
});
