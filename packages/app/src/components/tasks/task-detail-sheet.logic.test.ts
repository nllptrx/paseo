import { describe, expect, it } from "vitest";
import type { Step } from "@getpaseo/protocol/tasks/workflow";
import { resolveSubSurfaceTitle, resolveSurfaceStep } from "./task-detail-sheet.logic";

function step(id: string, name: string): Step {
  return {
    id,
    name,
    prompt: "do the thing",
    agents: [{ provider: "claude" }],
    completion: "all",
    workspace: { mode: "worktree" },
    trigger: { type: "manual" },
    runs: [],
  };
}

const steps = [step("s1", "Scaffold"), step("s2", "Implement")];

describe("resolveSurfaceStep", () => {
  it("resolves the step a step sub-surface names", () => {
    expect(resolveSurfaceStep({ kind: "step", stepId: "s2" }, steps)).toEqual({
      surfaceStep: steps[1],
      surfaceStepIndex: 1,
    });
  });

  it("reports a step that left the plan while its surface was open", () => {
    expect(resolveSurfaceStep({ kind: "step", stepId: "gone" }, steps)).toEqual({
      surfaceStep: undefined,
      surfaceStepIndex: -1,
    });
  });

  it("reads no step for the other sub-surfaces", () => {
    expect(resolveSurfaceStep({ kind: "plan" }, steps).surfaceStepIndex).toBe(-1);
    expect(resolveSurfaceStep({ kind: "automation" }, steps).surfaceStepIndex).toBe(-1);
    expect(resolveSurfaceStep(null, steps).surfaceStepIndex).toBe(-1);
  });
});

describe("resolveSubSurfaceTitle", () => {
  it("titles the plan editor, so editing a plan reads as part of the task", () => {
    expect(
      resolveSubSurfaceTitle({
        subSurface: { kind: "plan" },
        surfaceStep: undefined,
        surfaceStepIndex: -1,
      }),
    ).toBe("Edit plan");
  });

  it("titles the automation surface", () => {
    expect(
      resolveSubSurfaceTitle({
        subSurface: { kind: "automation" },
        surfaceStep: undefined,
        surfaceStepIndex: -1,
      }),
    ).toBe("Automation & delivery");
  });

  it("numbers a step from its position in the plan", () => {
    expect(
      resolveSubSurfaceTitle({
        subSurface: { kind: "step", stepId: "s2" },
        surfaceStep: steps[1],
        surfaceStepIndex: 1,
      }),
    ).toBe("Step 2 · Implement");
  });

  it("falls back to a bare title when the step is gone", () => {
    expect(
      resolveSubSurfaceTitle({
        subSurface: { kind: "step", stepId: "gone" },
        surfaceStep: undefined,
        surfaceStepIndex: -1,
      }),
    ).toBe("Step");
  });
});
