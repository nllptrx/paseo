import {
  resolveTaskExecutionPolicy,
  type Task,
  type TaskProject,
} from "@getpaseo/protocol/tasks/types";
import type { TaskService } from "./service.js";

export type TaskAgentBriefingRole =
  | "worker"
  | "workflow_step"
  | "reviewer"
  | "corrector"
  | "integration_fixer";

export interface TaskAgentBriefingStep {
  name: string;
  index: number;
  total: number;
}

export interface TaskAgentBriefingSource extends Pick<
  TaskService,
  "getTask" | "getProject" | "listBlockers" | "listDependents"
> {}

export interface BuildTaskAgentBriefingInput {
  taskService: TaskAgentBriefingSource;
  taskId: string;
  role: TaskAgentBriefingRole;
  toolsAvailable: boolean;
  step?: TaskAgentBriefingStep;
}

function taskKey(project: TaskProject, task: Task): string {
  return `${project.prefix}-${task.number}`;
}

async function getParentChain(taskService: TaskAgentBriefingSource, task: Task): Promise<Task[]> {
  const chain: Task[] = [];
  let parentTaskId = task.parentTaskId;
  while (parentTaskId) {
    const parent = await taskService.getTask(parentTaskId);
    if (!parent) {
      break;
    }
    chain.unshift(parent);
    parentTaskId = parent.parentTaskId;
  }
  return chain;
}

function formatTasks(project: TaskProject, tasks: readonly Task[]): string {
  if (tasks.length === 0) {
    return "none";
  }
  return tasks.map((task) => `${taskKey(project, task)} (${task.status})`).join(", ");
}

function describeReview(input: {
  task: Task;
  reviewEnabled: boolean;
  reviewerPresetId: string | null;
}): string {
  if (input.reviewEnabled && input.reviewerPresetId) {
    return "an agent reviewer judges the integrated task branch";
  }
  if (input.reviewEnabled || input.task.parentTaskId === null) {
    return "the integrated task branch waits in Review for a human verdict";
  }
  return "review is disabled here; a subtask can reach Done after integration into its parent";
}

function describeRole(role: TaskAgentBriefingRole): string {
  switch (role) {
    case "worker":
      return "worker attached to this card";
    case "workflow_step":
      return "worker for one workflow step; the step is not a task and has no task-like state";
    case "reviewer":
      return "independent reviewer of the integrated task branch";
    case "corrector":
      return "worker correcting a rejected review";
    case "integration_fixer":
      return "worker resolving a failed task-branch integration";
  }
}

function lifecycleLines(role: TaskAgentBriefingRole): string[] {
  if (role === "reviewer") {
    return [
      "- Record findings on the card, then submit exactly one verdict with review_task.",
      "- Ending without a verdict leaves the card in Review and the board reports the missing verdict.",
    ];
  }
  if (role === "workflow_step") {
    return [
      "- Finishing this turn settles only this workflow step. Later steps remain gated until earlier steps settle.",
      "- The final successful step settles the task, then integration and review/done rules run.",
    ];
  }
  if (role === "integration_fixer") {
    return [
      "- Finishing retries the same integration gate; unresolved conflicts return the card to Working again.",
      "- After integration, the task moves to Review or Done according to the effective policy.",
    ];
  }
  if (role === "corrector") {
    return [
      "- Finishing settles the corrected work, retries integration, and sends the result through review again.",
      "- Do not reopen completed subtasks when correcting an aggregate's integrated result.",
    ];
  }
  return [
    "- Finishing this turn green settles attached work; failure leaves the card where it is.",
    "- Settlement integrates the workspace into the canonical task branch, then moves the task to Review or Done.",
    "- Root tasks always park in Review until a human or agent submits a verdict.",
  ];
}

function toolLines(role: TaskAgentBriefingRole, toolsAvailable: boolean): string[] {
  if (!toolsAvailable) {
    return [
      "Task tools are unavailable in this run because daemon MCP injection is disabled. Do not invent tool calls; report the result in chat.",
    ];
  }
  const lines = [
    "Task tools:",
    "- get_task_context: refresh your live task position at turn start, before finishing, and after any resume.",
    "- read_board_feed: read typed board history when you need earlier transitions, verdicts, or cross-card updates.",
    "- comment_task: leave durable progress, findings, or results on a card. Use delivery only when another card is blocked or invalidated.",
    "- list_tasks and list_task_blockers: inspect neighboring work and open dependencies.",
  ];
  if (role === "reviewer") {
    lines.push(
      "- review_task: submit approve or reject for this exact task; include actionable feedback when rejecting.",
    );
  } else {
    lines.push(
      "- create_task, update_task, attach_task_agent, add_task_dependency, remove_task_dependency, add_task_workflow, get_task_workflow, run_task_step, list_task_presets, and delegate_task: use only when this task asks you to structure or dispatch board work.",
    );
  }
  return lines;
}

export async function buildTaskAgentBriefing(input: BuildTaskAgentBriefingInput): Promise<string> {
  const task = await input.taskService.getTask(input.taskId);
  if (!task) {
    throw new Error(`Task not found: ${input.taskId}`);
  }
  const project = await input.taskService.getProject(task.projectId);
  if (!project) {
    throw new Error(`Task project not found: ${task.projectId}`);
  }
  const parent = task.parentTaskId ? await input.taskService.getTask(task.parentTaskId) : null;
  const [parentChain, blockers, dependentIds] = await Promise.all([
    getParentChain(input.taskService, task),
    input.taskService.listBlockers(task.id),
    input.taskService.listDependents(task.id),
  ]);
  const dependents = (
    await Promise.all(dependentIds.map((taskId) => input.taskService.getTask(taskId)))
  ).filter((candidate): candidate is Task => candidate !== null);
  const policy = resolveTaskExecutionPolicy(
    project.board,
    task.executionPolicy,
    parent?.executionPolicy,
  );
  const lines = [
    "Paseo task environment",
    "The tracker card and board feed are the coordination layer. There is no direct agent-to-agent bus, and board awareness is pulled through task tools rather than pushed into a running turn.",
    "",
    `Task: ${taskKey(project, task)}`,
    `Task ID: ${task.id}`,
    `Status: ${task.status}`,
    `Role: ${describeRole(input.role)}`,
    `Parent chain: ${formatTasks(project, parentChain)}`,
    `Open blockers: ${formatTasks(project, blockers)}`,
    `Dependents: ${formatTasks(project, dependents)}`,
    `Review mode: ${describeReview({ task, ...policy })}`,
  ];
  if (input.step) {
    lines.push(
      `Workflow position: step ${input.step.index} of ${input.step.total} — ${input.step.name}`,
    );
  }
  lines.push("", "When this turn finishes:", ...lifecycleLines(input.role), "");
  lines.push(...toolLines(input.role, input.toolsAvailable));
  return lines.join("\n");
}

export function extendTaskAgentBriefing(briefing: string, instructions: string): string {
  const trimmed = instructions.trim();
  return trimmed.length > 0 ? `${briefing}\n\n${trimmed}` : briefing;
}
