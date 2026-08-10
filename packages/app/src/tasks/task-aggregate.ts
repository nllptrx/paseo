import type {
  ResolvedTaskExecutionPolicy,
  TaskExecutionPolicy,
  TaskExecutionSpec,
} from "@getpaseo/protocol/tasks/types";

/**
 * What a new subtask is before it is created: a title, optionally the preset
 * that will run it, and whether it waits for its sibling or starts beside it.
 * A plain value with pure transitions — the sheet holds one of these and
 * dispatches intent, so the rules are testable without rendering the sheet.
 */
export interface SubtaskDraft {
  title: string;
  /** Empty means no preset: the subtask is created and started by hand. */
  presetId: string;
  parallel: boolean;
}

export const EMPTY_SUBTASK_DRAFT: SubtaskDraft = { title: "", presetId: "", parallel: false };

export function withSubtaskTitle(draft: SubtaskDraft, title: string): SubtaskDraft {
  return { ...draft, title };
}

export function withSubtaskPreset(draft: SubtaskDraft, presetId: string): SubtaskDraft {
  return { ...draft, presetId };
}

export function withSubtaskParallel(draft: SubtaskDraft, parallel: boolean): SubtaskDraft {
  return { ...draft, parallel };
}

export function canCreateSubtask(draft: SubtaskDraft): boolean {
  return draft.title.trim().length > 0;
}

export interface SubtaskCreateInput {
  projectId: string;
  parentTaskId: string;
  title: string;
  parallel?: boolean;
  executionSpec?: TaskExecutionSpec;
}

/**
 * A chained subtask with a preset starts itself when the phase before it
 * settles. A parallel one has nothing to wait for, so its preset is recorded
 * and started by hand — a trigger that can never fire would read as automation
 * that silently does nothing.
 */
export function toSubtaskCreateInput(
  draft: SubtaskDraft,
  parent: { id: string; projectId: string },
): SubtaskCreateInput | null {
  const title = draft.title.trim();
  if (title.length === 0) {
    return null;
  }
  return {
    projectId: parent.projectId,
    parentTaskId: parent.id,
    title,
    ...(draft.parallel ? { parallel: true } : {}),
    ...(draft.presetId
      ? {
          executionSpec: {
            presetId: draft.presetId,
            trigger: draft.parallel ? ("manual" as const) : ("on_unblocked" as const),
          },
        }
      : {}),
  };
}

/**
 * The two review levels an aggregate has, as the four choices a person makes
 * about them. `review` is the parent's own final review; `subtaskReview` is what
 * its children inherit, which is why "final only" is one disabled and the other
 * required rather than a third value of one field.
 */
export type ReviewMode = "inherit" | "final" | "each_and_final" | "each" | "off";

export const REVIEW_MODE_LABELS: Record<ReviewMode, string> = {
  inherit: "Board default",
  final: "Final result only",
  each_and_final: "Each subtask and the final result",
  each: "Each subtask only",
  off: "No review",
};

export const REVIEW_MODES: readonly ReviewMode[] = [
  "inherit",
  "final",
  "each_and_final",
  "each",
  "off",
];

/** A policy written before this control could say only one of the two tiers;
 * such a pair reads as the mode nearest to it and is normalized on the next
 * write, because every write sets both. */
export function resolveReviewMode(policy: TaskExecutionPolicy): ReviewMode {
  const own = policy.review ?? "inherit";
  const children = policy.subtaskReview ?? "inherit";
  if (own === "inherit" && children === "inherit") return "inherit";
  if (own === "required" && children === "required") return "each_and_final";
  if (own === "required") return "final";
  if (children === "required") return "each";
  return "off";
}

/** Writes both tiers at once, so the pair can never say two different things. */
export function applyReviewMode(
  policy: TaskExecutionPolicy,
  mode: ReviewMode,
): TaskExecutionPolicy {
  const { review: _review, subtaskReview: _subtaskReview, ...rest } = policy;
  if (mode === "inherit") {
    return rest;
  }
  if (mode === "final") {
    return { ...rest, review: "required", subtaskReview: "disabled" };
  }
  if (mode === "each_and_final") {
    return { ...rest, review: "required", subtaskReview: "required" };
  }
  if (mode === "each") {
    return { ...rest, review: "disabled", subtaskReview: "required" };
  }
  return { ...rest, review: "disabled", subtaskReview: "disabled" };
}

/** The review half of the automation summary for a task with subtasks. */
export function formatReviewModeSummary(
  mode: ReviewMode,
  effective: Pick<ResolvedTaskExecutionPolicy, "reviewEnabled">,
): string {
  if (mode === "inherit") {
    return effective.reviewEnabled
      ? "Subtasks and the final result follow the board default, which requires review."
      : "Subtasks and the final result follow the board default, which requires no review.";
  }
  if (mode === "final") {
    return "Only the integrated result is reviewed.";
  }
  if (mode === "each_and_final") {
    return "Every subtask is reviewed, then the integrated result.";
  }
  if (mode === "each") {
    return "Every subtask is reviewed; the integrated result is not.";
  }
  return "Nothing here is reviewed.";
}

/** Why a worker cannot be started on this card. The daemon refuses the same
 * thing, and a control that throws when pressed is worse than one that says. */
export const AGGREGATE_WORK_REFUSAL =
  "This task has subtasks, so it holds no workers of its own. Start work on a subtask.";
