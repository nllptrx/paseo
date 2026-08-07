import type { Step, StepRun, StepRunStatus } from "@getpaseo/protocol/kanban/types";
import { describe, expect, it } from "vitest";
import {
  describeStepAgents,
  isStepGateOpen,
  resolveStepActions,
  resolveStepChatTarget,
  resolveStepRunHistory,
  resolveStepStatus,
} from "./step-detail";

function run(overrides: Partial<StepRun> = {}): StepRun {
  return {
    id: "run-1",
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:01:00.000Z",
    status: "succeeded",
    agentIds: ["agent-1"],
    workspaceIds: ["ws-1"],
    scheduleId: null,
    error: null,
    ...overrides,
  };
}

function step(overrides: Partial<Step> = {}): Step {
  return {
    id: "step-1",
    name: "Build",
    prompt: "build it",
    agents: [{ provider: "claude" }],
    completion: "all",
    workspace: { mode: "worktree" },
    trigger: { type: "manual" },
    runs: [],
    ...overrides,
  };
}

function stepWith(status: StepRunStatus | null, overrides: Partial<Step> = {}): Step {
  return step({ runs: status === null ? [] : [run({ status })], ...overrides });
}

describe("resolveStepStatus", () => {
  it("reads the last run, not the first", () => {
    expect(
      resolveStepStatus(step({ runs: [run({ status: "failed" }), run({ status: "succeeded" })] })),
    ).toBe("succeeded");
  });

  it("is null for a step that never ran", () => {
    expect(resolveStepStatus(step())).toBeNull();
  });
});

describe("isStepGateOpen", () => {
  it("is always open for the first step", () => {
    expect(isStepGateOpen([stepWith(null)], 0)).toBe(true);
  });

  it("opens on the previous step succeeding or being skipped", () => {
    expect(isStepGateOpen([stepWith("succeeded"), stepWith(null)], 1)).toBe(true);
    expect(isStepGateOpen([stepWith("skipped"), stepWith(null)], 1)).toBe(true);
  });

  it("stays shut while the previous step is unfinished or failed", () => {
    expect(isStepGateOpen([stepWith(null), stepWith(null)], 1)).toBe(false);
    expect(isStepGateOpen([stepWith("running"), stepWith(null)], 1)).toBe(false);
    expect(isStepGateOpen([stepWith("failed"), stepWith(null)], 1)).toBe(false);
  });
});

describe("resolveStepActions", () => {
  it("offers run and skip to a step that has never started", () => {
    expect(resolveStepActions([stepWith(null)], 0)).toEqual(["run", "skip"]);
  });

  it("offers retry instead of run once a run has failed", () => {
    expect(resolveStepActions([stepWith("failed")], 0)).toEqual(["retry", "skip"]);
    expect(resolveStepActions([stepWith("interrupted")], 0)).toEqual(["retry", "skip"]);
    expect(resolveStepActions([stepWith("canceled")], 0)).toEqual(["retry", "skip"]);
  });

  it("offers only cancel while a run is going", () => {
    expect(resolveStepActions([stepWith("running")], 0)).toEqual(["cancel"]);
  });

  it("offers nothing to a step that has settled successfully", () => {
    expect(resolveStepActions([stepWith("succeeded")], 0)).toEqual([]);
    expect(resolveStepActions([stepWith("skipped")], 0)).toEqual([]);
  });

  it("drops run and retry behind a closed gate but keeps skip", () => {
    expect(resolveStepActions([stepWith(null), stepWith(null)], 1)).toEqual(["skip"]);
    expect(resolveStepActions([stepWith("failed"), stepWith("failed")], 1)).toEqual(["skip"]);
  });
});

describe("resolveStepRunHistory", () => {
  it("returns runs newest first without mutating the step", () => {
    const target = step({ runs: [run({ id: "run-1" }), run({ id: "run-2" })] });

    expect(resolveStepRunHistory(target).map((entry) => entry.id)).toEqual(["run-2", "run-1"]);
    expect(target.runs.map((entry) => entry.id)).toEqual(["run-1", "run-2"]);
  });
});

describe("resolveStepChatTarget", () => {
  it("prefers the run still going over a finished one", () => {
    const target = step({
      runs: [
        run({ id: "run-1", status: "failed", agentIds: ["agent-old"] }),
        run({ id: "run-2", status: "running", agentIds: ["agent-live"] }),
      ],
    });

    expect(resolveStepChatTarget(target)).toEqual({ workspaceId: "ws-1", agentId: "agent-live" });
  });

  it("falls through a skip to the last run that had an agent", () => {
    const target = step({
      runs: [
        run({ id: "run-1", agentIds: ["agent-1"] }),
        run({ id: "run-2", status: "skipped", agentIds: [], workspaceIds: [] }),
      ],
    });

    expect(resolveStepChatTarget(target)).toEqual({ workspaceId: "ws-1", agentId: "agent-1" });
  });

  it("is null when nothing ever ran", () => {
    expect(resolveStepChatTarget(step())).toBeNull();
  });
});

describe("describeStepAgents", () => {
  it("reports the pinned model, and null when the provider default applies", () => {
    const target = step({
      agents: [{ provider: "claude", model: "opus" }, { provider: "codex" }],
    });

    expect(describeStepAgents(target)).toEqual([
      { key: "0:claude", provider: "claude", model: "opus" },
      { key: "1:codex", provider: "codex", model: null },
    ]);
  });
});
