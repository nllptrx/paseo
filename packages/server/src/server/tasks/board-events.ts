import type { Task, TaskBoardEvent, TaskProject, TaskStatus } from "@getpaseo/protocol/tasks/types";

export const BOARD_EVENT_KINDS = [
  "task_created",
  "task_moved",
  "task_settled",
  "task_approved",
  "task_rejected",
  "task_completion_blocked",
  "task_integration_failed",
  "task_auto_started",
  "task_auto_start_failed",
  "agent_attached",
  "agent_stalled",
  "agent_needs_input",
  "review_findings",
  "review_stalled",
  "review_failed",
  "correction_failed",
] as const;

export type BoardEventKind = (typeof BOARD_EVENT_KINDS)[number];

export interface BoardEventInput {
  kind: BoardEventKind;
  taskId: string;
  parentTaskId?: string | null;
  agentId?: string;
  previousStatus?: TaskStatus;
  status?: TaskStatus;
  verdict?: "approve" | "reject";
  cause: string;
}

export function toTaskBoardEvent(input: BoardEventInput): TaskBoardEvent {
  return { ...input };
}

export function renderBoardEvent(input: {
  project: TaskProject;
  task: Task;
  event: BoardEventInput;
}): string {
  if (input.event.kind === "review_findings") {
    return input.event.cause;
  }
  if (input.event.kind === "review_stalled") {
    return `The ${input.event.cause}.`;
  }
  const key = `${input.project.prefix}-${input.task.number}`;
  const separator =
    input.event.kind === "agent_stalled" || input.event.kind === "agent_needs_input" ? ":" : "";
  return `${key} "${input.task.title}"${separator} ${input.event.cause}.`;
}

export function isReviewVerdictEvent(
  event: TaskBoardEvent | undefined,
): event is TaskBoardEvent & { verdict: "approve" | "reject" } {
  return (
    (event?.kind === "task_approved" || event?.kind === "task_rejected") &&
    event.verdict !== undefined
  );
}
