import type { TaskExecutionPolicy } from "@getpaseo/protocol/tasks/types";
import { resolveTaskExecutionPolicy } from "@getpaseo/protocol/tasks/types";
import { describe, expect, it } from "vitest";
import {
  applyReviewMode,
  canCreateSubtask,
  EMPTY_SUBTASK_DRAFT,
  formatReviewModeSummary,
  resolveReviewMode,
  toSubtaskCreateInput,
  withSubtaskParallel,
  withSubtaskPreset,
  withSubtaskTitle,
} from "./task-aggregate";

const parent = { id: "parent-1", projectId: "prj-1" };

describe("subtask draft", () => {
  it("refuses a title that is only whitespace", () => {
    expect(canCreateSubtask(EMPTY_SUBTASK_DRAFT)).toBe(false);
    expect(canCreateSubtask(withSubtaskTitle(EMPTY_SUBTASK_DRAFT, "   "))).toBe(false);
    expect(canCreateSubtask(withSubtaskTitle(EMPTY_SUBTASK_DRAFT, "Ship it"))).toBe(true);
    expect(toSubtaskCreateInput(withSubtaskTitle(EMPTY_SUBTASK_DRAFT, " "), parent)).toBeNull();
  });

  it("creates a chained subtask with no preset by default", () => {
    const draft = withSubtaskTitle(EMPTY_SUBTASK_DRAFT, "  Phase one  ");
    expect(toSubtaskCreateInput(draft, parent)).toEqual({
      projectId: "prj-1",
      parentTaskId: "parent-1",
      title: "Phase one",
    });
  });

  /** A chain runs hands-free: each phase starts when the one before it settles. */
  it("gives a chained subtask with a preset the unblocked trigger", () => {
    const draft = withSubtaskPreset(withSubtaskTitle(EMPTY_SUBTASK_DRAFT, "Phase two"), "preset-1");
    expect(toSubtaskCreateInput(draft, parent)).toEqual({
      projectId: "prj-1",
      parentTaskId: "parent-1",
      title: "Phase two",
      executionSpec: { presetId: "preset-1", trigger: "on_unblocked" },
    });
  });

  /** A parallel subtask has no blocker to wait for, so an unblocked trigger
   * would be automation that never fires. */
  it("records a parallel subtask's preset as started by hand", () => {
    const draft = withSubtaskParallel(
      withSubtaskPreset(withSubtaskTitle(EMPTY_SUBTASK_DRAFT, "Beside it"), "preset-1"),
      true,
    );
    expect(toSubtaskCreateInput(draft, parent)).toEqual({
      projectId: "prj-1",
      parentTaskId: "parent-1",
      title: "Beside it",
      parallel: true,
      executionSpec: { presetId: "preset-1", trigger: "manual" },
    });
  });
});

describe("review modes", () => {
  it("reads an untouched policy as the board default", () => {
    expect(resolveReviewMode({})).toBe("inherit");
    expect(applyReviewMode({ review: "required", subtaskReview: "disabled" }, "inherit")).toEqual(
      {},
    );
  });

  it("writes both tiers for every mode and reads each back", () => {
    const modes = ["final", "each_and_final", "each", "off"] as const;
    for (const mode of modes) {
      const written = applyReviewMode({}, mode);
      expect(resolveReviewMode(written)).toBe(mode);
    }
    expect(applyReviewMode({}, "final")).toEqual({ review: "required", subtaskReview: "disabled" });
    expect(applyReviewMode({}, "each")).toEqual({ review: "disabled", subtaskReview: "required" });
  });

  it("keeps the rest of the policy when the mode changes", () => {
    const policy: TaskExecutionPolicy = { workspace: "dedicated", maxReviewIterations: 5 };
    expect(applyReviewMode(policy, "each_and_final")).toEqual({
      workspace: "dedicated",
      maxReviewIterations: 5,
      review: "required",
      subtaskReview: "required",
    });
  });

  it("summarizes each mode in plain language", () => {
    const effective = resolveTaskExecutionPolicy(
      {
        reviewEnabled: true,
        reviewOnReject: "in_progress",
        archiveWorkspacesOnDone: false,
      },
      {},
    );
    expect(formatReviewModeSummary("inherit", effective)).toContain("requires review");
    expect(formatReviewModeSummary("final", effective)).toBe(
      "Only the integrated result is reviewed.",
    );
    expect(formatReviewModeSummary("each", effective)).toContain("the integrated result is not");
    expect(formatReviewModeSummary("off", effective)).toBe("Nothing here is reviewed.");
  });
});
