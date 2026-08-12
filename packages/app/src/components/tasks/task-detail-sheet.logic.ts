import type { Step } from "@getpaseo/protocol/tasks/workflow";

/**
 * The surface stacked over the tab body: a step's own screen, the automation &
 * delivery screen, or the plan editor. Each is reached with a back arrow and
 * belongs to the task detail sheet, so leaving one returns to the task and
 * never to the board. On desktop only the left pane is replaced; the rail stays.
 */
export type TaskDetailSubSurface =
  | { kind: "automation" }
  | { kind: "step"; stepId: string }
  | { kind: "plan" };

export function resolveSurfaceStep(
  subSurface: TaskDetailSubSurface | null,
  steps: readonly Step[],
): { surfaceStep: Step | undefined; surfaceStepIndex: number } {
  if (subSurface?.kind !== "step") {
    return { surfaceStep: undefined, surfaceStepIndex: -1 };
  }
  const surfaceStepIndex = steps.findIndex((step) => step.id === subSurface.stepId);
  return {
    surfaceStep: surfaceStepIndex >= 0 ? steps[surfaceStepIndex] : undefined,
    surfaceStepIndex,
  };
}

/** The header title a sub-surface takes over, beside its back arrow. */
export function resolveSubSurfaceTitle(input: {
  subSurface: TaskDetailSubSurface;
  surfaceStep: Step | undefined;
  surfaceStepIndex: number;
}): string {
  if (input.subSurface.kind === "automation") {
    return "Automation & delivery";
  }
  if (input.subSurface.kind === "plan") {
    return "Edit plan";
  }
  if (input.surfaceStep) {
    return `Step ${input.surfaceStepIndex + 1} · ${input.surfaceStep.name}`;
  }
  return "Step";
}
