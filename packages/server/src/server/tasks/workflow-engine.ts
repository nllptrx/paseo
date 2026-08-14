import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "pino";
import type {
  Step,
  StepAgentSpec,
  StepRun,
  StepRunStatus,
} from "@getpaseo/protocol/tasks/workflow";
import {
  resolveTaskExecutionPolicy,
  type ResolvedTaskExecutionPolicy,
  type Task,
  type TaskAgentLink,
} from "@getpaseo/protocol/tasks/types";
import { observeAgentCompletion } from "../agent/agent-completion.js";
import type { AgentManager, ManagedAgent } from "../agent/agent-manager.js";
import { formatProviderModel, type BoundCreateAgentCommand } from "../agent/create-agent/create.js";
import { cancelAgentRunCommand } from "../agent/lifecycle-command.js";
import type { ScheduleRunLifecycleEvent, ScheduleService } from "../schedule/service.js";
import type { PersistedWorkspaceRecord } from "../workspace-registry.js";
import type { CreatePaseoWorktreeWorkflowResult } from "../worktree-session.js";
import { mergeToBase } from "../../utils/checkout-git.js";
import { runGitCommand } from "../../utils/run-git-command.js";
import type { TaskService } from "./service.js";
import { isReviewVerdictEvent } from "./board-events.js";
import {
  buildTaskAgentBriefing,
  extendTaskAgentBriefing,
  type TaskAgentBriefingRole,
  type TaskAgentBriefingStep,
} from "./agent-briefing.js";
import { checkStepEvidence, readHeadCommit, type StepEvidenceResult } from "./step-verification.js";

const RETRYABLE_RUN_STATUSES: ReadonlySet<StepRunStatus> = new Set([
  "failed",
  "interrupted",
  "canceled",
]);

/** A step is addressed by the task that owns the workflow. There is no plan and
 * no nesting, so this is the whole address. */
/** A one-off way to run a task, described at the moment of starting it. */
export interface TaskDelegateSpec {
  provider: string;
  model?: string | null;
  modeId?: string | null;
  thinkingOptionId?: string | null;
  featureValues?: Record<string, unknown>;
  instructions?: string;
  environmentKind?: "project_default" | "new_worktree";
}

/** What `delegate` runs as, whether it was saved or described in the moment. */
interface ResolvedDelegateSpec {
  id: string | null;
  provider: string;
  model: string | null;
  modeId: string | null;
  thinkingOptionId: string | null;
  featureValues?: Record<string, unknown>;
  instructions: string;
  environmentKind: "project_default" | "new_worktree";
  baseBranch: string | null;
}

export interface TaskStepIdentifier {
  taskId: string;
  stepId: string;
}

interface WorktreeWorkspaceInput {
  cwd: string;
  firstAgentContext: { prompt: string };
  /** Where the new branch starts. A subtask starts from its parent's branch so
   * the two stack instead of racing main. */
  refName?: string;
}

export interface TaskGitIntegration {
  isRepository(cwd: string): Promise<boolean>;
  /** A repository on an unborn branch has no ref any branch can start from. */
  hasCommits(cwd: string): Promise<boolean>;
  resolveDefaultBranch(cwd: string): Promise<string>;
  branchExists(cwd: string, branch: string): Promise<boolean>;
  createBranch(cwd: string, branch: string, baseBranch: string): Promise<void>;
  integrateWorkspace(cwd: string, targetBranch: string, message: string): Promise<void>;
  integrateBranch(
    cwd: string,
    sourceBranch: string,
    targetBranch: string,
    message: string,
  ): Promise<void>;
}

/**
 * How many step runs this host dispatches at once. Every run can fan out to
 * several agents, so the real ceiling is higher — this bounds how many pieces
 * of work start, not how many processes exist.
 */
export const DEFAULT_MAX_CONCURRENT_RUNS = 3;

export interface TaskWorkflowEngineDeps {
  taskService: Pick<
    TaskService,
    | "getTask"
    | "getProject"
    | "getWorkflow"
    | "listWorkflows"
    | "mutateStep"
    | "attachAgent"
    | "listTaskAgents"
    | "listSubtasks"
    | "listBlockers"
    | "listDependents"
    | "countSubtasks"
    | "listBoardFeed"
    | "getPreset"
    | "updateTask"
    | "isAvailable"
    | "assertTaskClaimable"
    | "assertTaskExecutable"
  >;
  agentManager: AgentManager;
  createAgent: BoundCreateAgentCommand;
  scheduleService: Pick<ScheduleService, "createOrReplace" | "delete">;
  getWorkspace: (workspaceId: string) => Promise<PersistedWorkspaceRecord | null>;
  getProjectRootCwd: (paseoProjectId: string) => Promise<string>;
  createWorktreeWorkspace: (
    input: WorktreeWorkspaceInput,
  ) => Promise<CreatePaseoWorktreeWorkflowResult>;
  /** Opens the folder itself as a workspace, for projects Git cannot back. */
  createDirectoryWorkspace: (input: WorktreeWorkspaceInput) => Promise<PersistedWorkspaceRecord>;
  archiveWorkspace: (workspaceId: string) => Promise<void>;
  resumeAgent?: (input: { agentId: string; prompt: string }) => Promise<void>;
  logger: Logger;
  now?: () => Date;
  maxConcurrentRuns?: number;
  taskGit?: TaskGitIntegration;
}

interface AgentTarget {
  cwd: string;
  workspaceId: string;
  createdForRun?: boolean;
}

// Tracks the agents still in flight for one running StepRun so fan-out
// completion ("all agents settled") can be detected without polling. One
// tracker per run, discarded once the run reaches a terminal status.
/** The run a retry follows. The same conversation continues in the same
 * checkout when it still can: the agent that did the work holds the context a
 * fresh chat would have to re-derive. */
interface ResumeFromRun {
  agentIds: string[];
  error: string | null;
}

interface RunTracker {
  identifier: TaskStepIdentifier;
  runId: string;
  pending: Set<string>;
  failedReason: string | null;
  unsubscribes: Map<string, () => void>;
  /** Cleared whichever way the run ends, so a settled run never fires it. */
  timeout: ReturnType<typeof setTimeout> | null;
}

function latestRunOf(step: Step): StepRun | null {
  return step.runs.length > 0 ? step.runs[step.runs.length - 1] : null;
}

function requireStepIndex(steps: Step[], stepId: string): number {
  const index = steps.findIndex((step) => step.id === stepId);
  if (index === -1) {
    throw new Error(`Step not found: ${stepId}`);
  }
  return index;
}

async function commitWorkspaceChanges(cwd: string, message: string): Promise<void> {
  const status = await runGitCommand(["status", "--porcelain"], { cwd });
  if (!status.stdout.trim()) return;
  await runGitCommand(["add", "-A"], { cwd, timeout: 120_000 });
  await runGitCommand(
    [
      "-c",
      "user.name=Paseo",
      "-c",
      "user.email=paseo@localhost",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      message,
    ],
    { cwd, timeout: 120_000 },
  );
}

export const defaultTaskGitIntegration: TaskGitIntegration = {
  async isRepository(cwd) {
    const result = await runGitCommand(["rev-parse", "--git-dir"], {
      cwd,
      acceptExitCodes: [0, 128],
    });
    return result.exitCode === 0;
  },
  async hasCommits(cwd) {
    const head = await runGitCommand(["rev-parse", "--verify", "--quiet", "HEAD"], {
      cwd,
      acceptExitCodes: [0, 1, 128],
    });
    return head.stdout.trim().length > 0;
  },
  async resolveDefaultBranch(cwd) {
    const remote = await runGitCommand(
      ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
      { cwd, acceptExitCodes: [0, 1, 128] },
    );
    const remoteRef = remote.exitCode === 0 ? remote.stdout.trim() : "";
    if (remoteRef) {
      const localName = remoteRef.replace(/^origin\//, "");
      const local = await runGitCommand(
        ["show-ref", "--verify", "--quiet", `refs/heads/${localName}`],
        { cwd, acceptExitCodes: [0, 1] },
      );
      return local.exitCode === 0 ? localName : remoteRef;
    }
    const head = await runGitCommand(["rev-parse", "--verify", "--quiet", "HEAD"], {
      cwd,
      acceptExitCodes: [0, 1, 128],
    });
    if (!head.stdout.trim()) {
      throw new Error(
        `The project repository at ${cwd} has no commits yet, so agent work has nothing to branch from. Make an initial commit and try again.`,
      );
    }
    const current = await runGitCommand(["branch", "--show-current"], { cwd });
    if (!current.stdout.trim()) throw new Error("Unable to determine the project's default branch");
    return current.stdout.trim();
  },
  async branchExists(cwd, branch) {
    const result = await runGitCommand(
      ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
      { cwd, acceptExitCodes: [0, 1] },
    );
    return result.exitCode === 0;
  },
  async createBranch(cwd, branch, baseBranch) {
    await runGitCommand(["branch", branch, baseBranch], { cwd, timeout: 120_000 });
  },
  async integrateWorkspace(cwd, targetBranch, message) {
    await commitWorkspaceChanges(cwd, message);
    await mergeToBase(cwd, { baseRef: targetBranch, mode: "merge" });
  },
  async integrateBranch(cwd, sourceBranch, targetBranch) {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "paseo-task-integration-"));
    try {
      await runGitCommand(["worktree", "add", temporaryRoot, sourceBranch], {
        cwd,
        timeout: 120_000,
      });
      await mergeToBase(temporaryRoot, { baseRef: targetBranch, mode: "merge" });
    } finally {
      await runGitCommand(["worktree", "remove", "--force", temporaryRoot], {
        cwd,
        timeout: 120_000,
        acceptExitCodes: [0, 128],
      }).catch(() => undefined);
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  },
};

function stepAgentTitle(step: Step, spec: StepAgentSpec, agentIndex: number): string {
  const suffix = spec.model ? `${spec.provider}/${spec.model}` : spec.provider;
  return step.agents.length > 1
    ? `${step.name} (${agentIndex + 1}/${step.agents.length}) — ${suffix}`
    : step.name;
}

/**
 * What a reviewer is told. Deliberately spare: the card's own words and the
 * instruction to read the change. Handing it the worker's reasoning would give
 * it the conclusion it is supposed to reach independently.
 */
function buildReviewPrompt(input: {
  briefing: string;
  task: Pick<Task, "id" | "number" | "title" | "description">;
  projectPrefix: string;
  instructions: string;
}): string {
  const lines = [
    "You are reviewing a change someone else made. You did not write it and you have not seen how it was written.",
    "",
    `Task: ${input.projectPrefix}-${input.task.number}`,
    `Task ID: ${input.task.id}`,
    `Title: ${input.task.title}`,
  ];
  if (input.task.description.trim().length > 0) {
    lines.push("", input.task.description.trim());
  }
  if (input.instructions.trim().length > 0) {
    lines.push("", input.instructions.trim());
  }
  lines.push(
    "",
    "Read the diff in this workspace and decide whether it does what the task asks, correctly.",
    "Record what you found with comment_task, then call review_task with approve or reject and include the findings as feedback when rejecting.",
    "Reject when you cannot tell: an unverifiable change is not an approved one.",
  );
  return extendTaskAgentBriefing(input.briefing, lines.join("\n"));
}

/**
 * What the final review of an aggregate is told. Its subtasks were each judged
 * on their own branch, so re-reading their diffs would spend a review on
 * questions that already have answers. What nobody has looked at yet is the
 * integrated result: whether the parts fit, and whether anything fell between
 * them.
 */
function buildAggregateReviewPrompt(input: {
  briefing: string;
  task: Pick<Task, "id" | "number" | "title" | "description">;
  projectPrefix: string;
  instructions: string;
  childVerdicts: readonly string[];
}): string {
  const lines = [
    "You are reviewing the integrated result of work that was delivered by subtasks. You did not write any of it.",
    "",
    `Task: ${input.projectPrefix}-${input.task.number}`,
    `Task ID: ${input.task.id}`,
    `Title: ${input.task.title}`,
  ];
  if (input.task.description.trim().length > 0) {
    lines.push("", input.task.description.trim());
  }
  if (input.childVerdicts.length > 0) {
    lines.push(
      "",
      "How its subtasks were judged:",
      ...input.childVerdicts.map((line) => `- ${line}`),
    );
  }
  if (input.instructions.trim().length > 0) {
    lines.push("", input.instructions.trim());
  }
  lines.push(
    "",
    "This branch already carries every subtask's merged work. Judge the integration: whether the pieces fit together, whether the task as a whole is now done, and whether anything fell between the subtasks.",
    "Do not review each subtask's diff again — each was judged on its own branch.",
    "Record what you found with comment_task, then call review_task with approve or reject and include the findings as feedback when rejecting.",
    "Reject when you cannot tell: an unverifiable change is not an approved one.",
  );
  return extendTaskAgentBriefing(input.briefing, lines.join("\n"));
}

function buildWorkPrompt(input: {
  briefing: string;
  task: Pick<Task, "id" | "number" | "title" | "description">;
  projectPrefix: string;
  instructions: string;
}): string {
  const lines: string[] = [
    `Task: ${input.projectPrefix}-${input.task.number}`,
    `Task ID: ${input.task.id}`,
    `Title: ${input.task.title}`,
  ];
  if (input.task.description.trim().length > 0) {
    lines.push("", input.task.description.trim());
  }
  lines.push(
    "",
    "Implement this task in the current workspace. Use comment_task with the task ID above to record the result when finished.",
  );
  if (input.instructions.trim().length > 0) {
    lines.push("", input.instructions.trim());
  }
  return extendTaskAgentBriefing(input.briefing, lines.join("\n"));
}

function stepRunLabels(taskId: string, stepId: string, runId: string): Record<string, string> {
  return {
    "paseo.task-id": taskId,
    "paseo.step-id": stepId,
    "paseo.step-run-id": runId,
  };
}

/**
 * Runs a task's workflow: hard gates between steps, multi-agent fan-out
 * dispatch, and timed-step schedule materialization.
 *
 * There is no card-move path here. Where the card sits is the task's stored
 * status, and the only move this engine causes is the one it reports when the
 * last step settles green — the rules for that live with the tracker.
 */
export class TaskWorkflowEngine {
  private readonly taskService: TaskWorkflowEngineDeps["taskService"];
  private readonly agentManager: AgentManager;
  private readonly createAgent: BoundCreateAgentCommand;
  private readonly scheduleService: Pick<ScheduleService, "createOrReplace" | "delete">;
  private readonly getWorkspace: (workspaceId: string) => Promise<PersistedWorkspaceRecord | null>;
  private readonly getProjectRootCwd: (paseoProjectId: string) => Promise<string>;
  private readonly createWorktreeWorkspace: (
    input: WorktreeWorkspaceInput,
  ) => Promise<CreatePaseoWorktreeWorkflowResult>;
  private readonly createDirectoryWorkspace: (
    input: WorktreeWorkspaceInput,
  ) => Promise<PersistedWorkspaceRecord>;
  private readonly archiveWorkspace: (workspaceId: string) => Promise<void>;
  private readonly resumeAgent: TaskWorkflowEngineDeps["resumeAgent"];
  private readonly taskGit: TaskGitIntegration;
  private readonly logger: Logger;
  private readonly now: () => Date;
  private readonly runTrackers = new Map<string, RunTracker>();
  private readonly reservedRunIds = new Set<string>();
  private readonly maxConcurrentRuns: number;
  private readonly integrationBranchPromises = new Map<string, Promise<string>>();
  private readonly integrationBranchTails = new Map<string, Promise<void>>();
  private draining = false;
  private onWorkflowSettled: ((taskId: string) => void) | null = null;

  constructor(deps: TaskWorkflowEngineDeps) {
    this.taskService = deps.taskService;
    this.agentManager = deps.agentManager;
    this.createAgent = deps.createAgent;
    this.scheduleService = deps.scheduleService;
    this.getWorkspace = deps.getWorkspace;
    this.getProjectRootCwd = deps.getProjectRootCwd;
    this.createWorktreeWorkspace = deps.createWorktreeWorkspace;
    this.createDirectoryWorkspace = deps.createDirectoryWorkspace;
    this.archiveWorkspace = deps.archiveWorkspace;
    this.resumeAgent = deps.resumeAgent;
    this.taskGit = deps.taskGit ?? defaultTaskGitIntegration;
    this.logger = deps.logger.child({ module: "task-workflow-engine" });
    this.now = deps.now ?? (() => new Date());
    this.maxConcurrentRuns = deps.maxConcurrentRuns ?? DEFAULT_MAX_CONCURRENT_RUNS;
  }

  /** Task override, then the parent aggregate's, then the board — the same three
   * tiers the transition engine resolves, so dispatch and transitions cannot
   * disagree about what a subtask's plan asked for. */
  private async resolveEffectivePolicy(task: Task): Promise<ResolvedTaskExecutionPolicy> {
    const project = await this.taskService.getProject(task.projectId);
    const parent = task.parentTaskId ? await this.taskService.getTask(task.parentTaskId) : null;
    return resolveTaskExecutionPolicy(
      project?.board,
      task.executionPolicy,
      parent?.executionPolicy,
    );
  }

  /** Fired when a task's last step settles green. The engine only reports; where
   * the task moves is the tracker's decision. */
  setOnWorkflowSettled(listener: (taskId: string) => void): void {
    this.onWorkflowSettled = listener;
  }

  /**
   * Archive only after the task reaches its final Done state. Workflow
   * settlement may lead to review, and the reviewer must still be able to read
   * the checkout.
   *
   * A worktree a subtask chain shares outlives each subtask's Done, because the
   * next phase is still working in it. Those checkouts are released when the
   * aggregate settles; subtasks with worktrees of their own keep the per-task
   * timing.
   */
  async archiveTaskWorkspacesAfterDone(taskId: string): Promise<void> {
    const task = await this.taskService.getTask(taskId);
    if (!task) {
      return;
    }
    if ((await this.taskService.countSubtasks(taskId)) > 0) {
      await this.archiveWorkspacesIfConfigured(
        taskId,
        await this.collectFamilyWorkspaceIds(taskId),
      );
      return;
    }
    if (task.parentTaskId && (await this.sharesWorkspaceWithFamily(task))) {
      return;
    }
    await this.archiveWorkspacesIfConfigured(taskId, await this.collectTaskWorkspaceIds(taskId));
  }

  /** Every checkout the task's own work used: its workflow runs' workspaces and
   * the workspaces of the agents attached to it. */
  private async collectTaskWorkspaceIds(taskId: string): Promise<Set<string>> {
    const workspaceIds = new Set<string>();
    const workflow = await this.taskService.getWorkflow(taskId);
    for (const step of workflow?.steps ?? []) {
      for (const run of step.runs) {
        for (const workspaceId of run.workspaceIds) {
          workspaceIds.add(workspaceId);
        }
      }
    }
    for (const link of await this.taskService.listTaskAgents(taskId)) {
      workspaceIds.add(link.workspaceId);
    }
    return workspaceIds;
  }

  private async collectFamilyWorkspaceIds(taskId: string): Promise<Set<string>> {
    const workspaceIds = await this.collectTaskWorkspaceIds(taskId);
    for (const child of await this.taskService.listSubtasks(taskId)) {
      for (const workspaceId of await this.collectFamilyWorkspaceIds(child.id)) {
        workspaceIds.add(workspaceId);
      }
    }
    return workspaceIds;
  }

  private async sharesWorkspaceWithFamily(task: Task): Promise<boolean> {
    const parentTaskId = task.parentTaskId;
    if (!parentTaskId) {
      return false;
    }
    const own = await this.collectTaskWorkspaceIds(task.id);
    if (own.size === 0) {
      return false;
    }
    const family = await this.collectTaskWorkspaceIds(parentTaskId);
    for (const sibling of await this.taskService.listSubtasks(parentTaskId)) {
      if (sibling.id === task.id) {
        continue;
      }
      for (const workspaceId of await this.collectFamilyWorkspaceIds(sibling.id)) {
        family.add(workspaceId);
      }
    }
    for (const workspaceId of own) {
      if (family.has(workspaceId)) {
        return true;
      }
    }
    return false;
  }

  // Boot recovery: any step run still "running" when the daemon went down
  // cannot be trusted (its in-memory tracker is gone) — mark it interrupted.
  // No auto-resume: the user retries explicitly.
  async recoverInterruptedRuns(): Promise<void> {
    if (!(await this.taskService.isAvailable())) {
      return;
    }
    const workflows = await this.taskService.listWorkflows();
    const now = this.now().toISOString();
    for (const workflow of workflows) {
      for (const step of workflow.steps) {
        const latest = latestRunOf(step);
        if (!latest || latest.status !== "running") {
          continue;
        }
        await this.taskService.mutateStep({
          taskId: workflow.taskId,
          stepId: step.id,
          mutate: (current) => ({
            ...current,
            runs: current.runs.map((run) =>
              run.id === latest.id
                ? {
                    ...run,
                    status: "interrupted" as const,
                    endedAt: now,
                    error: run.error ?? "Daemon restarted before the step run completed",
                  }
                : run,
            ),
          }),
        });
      }
    }

    // Anything the crash left queued is still owed its turn.
    await this.drainQueue();
  }

  private async requireSteps(taskId: string): Promise<Step[]> {
    const workflow = await this.taskService.getWorkflow(taskId);
    if (!workflow) {
      throw new Error(`Task has no workflow: ${taskId}`);
    }
    return workflow.steps;
  }

  async runStep(identifier: TaskStepIdentifier): Promise<Step> {
    const steps = await this.requireSteps(identifier.taskId);
    const stepIndex = requireStepIndex(steps, identifier.stepId);
    this.assertGateOpen(steps, stepIndex);
    this.assertNotRunning(steps[stepIndex]);
    return this.dispatchRun(identifier, steps, stepIndex, null);
  }

  /** Reconciles a plan after editing. Enabling an automatic trigger after its
   * predecessor already settled should continue the plan instead of waiting
   * for a completion event that already happened. */
  async continueReadyWorkflow(taskId: string): Promise<void> {
    const steps = await this.requireSteps(taskId);
    for (let stepIndex = 0; stepIndex < steps.length; stepIndex += 1) {
      const latest = latestRunOf(steps[stepIndex]);
      if (latest?.status === "succeeded" || latest?.status === "skipped") {
        continue;
      }
      if (latest || stepIndex === 0) {
        return;
      }
      this.assertGateOpen(steps, stepIndex);
      await this.advanceStep(taskId, steps, stepIndex);
      return;
    }
  }

  async retryStep(identifier: TaskStepIdentifier): Promise<Step> {
    const steps = await this.requireSteps(identifier.taskId);
    const stepIndex = requireStepIndex(steps, identifier.stepId);
    this.assertGateOpen(steps, stepIndex);
    const step = steps[stepIndex];
    const latest = latestRunOf(step);
    if (!latest || !RETRYABLE_RUN_STATUSES.has(latest.status)) {
      throw new Error(`Step ${step.id} has no failed, canceled, or interrupted run to retry`);
    }
    return this.dispatchRun(identifier, steps, stepIndex, latest.workspaceIds, {
      agentIds: latest.agentIds,
      error: latest.error,
    });
  }

  async skipStep(identifier: TaskStepIdentifier): Promise<Step> {
    const steps = await this.requireSteps(identifier.taskId);
    const stepIndex = requireStepIndex(steps, identifier.stepId);
    this.assertNotRunning(steps[stepIndex]);
    const now = this.now().toISOString();
    const { step, steps: updatedSteps } = await this.taskService.mutateStep({
      ...identifier,
      mutate: (current) => ({
        ...current,
        runs: [
          ...current.runs,
          {
            id: randomUUID(),
            startedAt: now,
            endedAt: now,
            status: "skipped",
            agentIds: [],
            workspaceIds: [],
            scheduleId: null,
            error: null,
          },
        ],
      }),
    });
    await this.afterStepSettled(identifier.taskId, updatedSteps, stepIndex);
    return step;
  }

  async cancelStep(identifier: TaskStepIdentifier): Promise<Step> {
    const steps = await this.requireSteps(identifier.taskId);
    const stepIndex = requireStepIndex(steps, identifier.stepId);
    const latest = latestRunOf(steps[stepIndex]);
    if (latest?.status === "queued") {
      // Nothing has started, so there is nothing to stop: the run is withdrawn
      // rather than recorded as a cancellation of work that never happened.
      const now = this.now().toISOString();
      const { step: withdrawn } = await this.taskService.mutateStep({
        ...identifier,
        mutate: (current) => ({
          ...current,
          runs: current.runs.map((run) =>
            run.id === latest.id
              ? {
                  ...run,
                  status: "canceled" as const,
                  endedAt: now,
                  error: "Withdrawn from the queue",
                }
              : run,
          ),
        }),
      });
      return withdrawn;
    }
    if (!latest || latest.status !== "running") {
      throw new Error(`Step ${identifier.stepId} has no run in progress to cancel`);
    }
    // Unsubscribe before issuing the cancel: cancelling an agent drives its
    // lifecycle through "idle" the same way finishing does, which would
    // otherwise race the completion observer into reporting a spurious
    // "finished" and writing over this cancellation.
    this.clearTracker(latest.id);
    for (const agentId of latest.agentIds) {
      try {
        await cancelAgentRunCommand(
          { agentManager: this.agentManager, logger: this.logger },
          agentId,
        );
      } catch (error) {
        this.logger.warn({ err: error, agentId }, "Failed to cancel step-run agent");
      }
    }
    const now = this.now().toISOString();
    const { step } = await this.taskService.mutateStep({
      ...identifier,
      mutate: (current) => ({
        ...current,
        runs: current.runs.map((run) =>
          run.id === latest.id
            ? { ...run, status: "canceled" as const, endedAt: now, error: run.error ?? "Canceled" }
            : run,
        ),
      }),
    });
    return step;
  }

  private assertGateOpen(steps: Step[], stepIndex: number): void {
    if (stepIndex === 0) {
      return;
    }
    const previous = steps[stepIndex - 1];
    const latest = latestRunOf(previous);
    if (!latest || (latest.status !== "succeeded" && latest.status !== "skipped")) {
      throw new Error(
        `Step ${steps[stepIndex].id} is not ready: step ${previous.id} has not succeeded or been skipped`,
      );
    }
  }

  private assertNotRunning(step: Step): void {
    const latest = latestRunOf(step);
    if (latest?.status === "running" || latest?.status === "queued") {
      throw new Error(`Step ${step.id} already has a run in progress`);
    }
  }

  // trigger:immediate or trigger:schedule steps advance themselves once gated
  // open; trigger:manual and explicit run/retry requests go through
  // runStep/retryStep, which reach dispatchRun with the same effect.
  private async advanceStep(taskId: string, steps: Step[], stepIndex: number): Promise<void> {
    const step = steps[stepIndex];
    if (step.trigger.type === "manual") {
      return;
    }
    const identifier = { taskId, stepId: step.id };
    if (step.trigger.type === "schedule") {
      await this.materializeScheduleForStep(identifier, steps, stepIndex);
      return;
    }
    await this.dispatchRun(identifier, steps, stepIndex, null);
  }

  private async materializeScheduleForStep(
    identifier: TaskStepIdentifier,
    steps: Step[],
    stepIndex: number,
  ): Promise<void> {
    const step = steps[stepIndex];
    if (step.trigger.type !== "schedule") {
      throw new Error(`Step ${step.id} does not have a schedule trigger`);
    }
    await this.taskService.assertTaskClaimable(identifier.taskId);
    await this.taskService.assertTaskExecutable(identifier.taskId);
    if (step.agents.length !== 1) {
      throw new Error(
        `Step ${step.id} uses a schedule and must have exactly one agent; scheduled fan-out is not supported`,
      );
    }
    const primarySpec = step.agents[0];
    const prompt = await this.buildTaskWorkPrompt({
      taskId: identifier.taskId,
      instructions: primarySpec.promptOverride ?? step.prompt,
      role: "workflow_step",
      step: { name: step.name, index: stepIndex + 1, total: steps.length },
    });
    const target = await this.resolveTargetsForStep(identifier, steps, stepIndex, 1, prompt);
    const runId = randomUUID();
    const schedule = await this.scheduleService.createOrReplace({
      name: `task-step-${step.id}`,
      prompt,
      cadence: step.trigger.cadence,
      maxRuns: 1,
      runOnCreate: false,
      target: {
        type: "new-agent",
        config: {
          provider: primarySpec.provider,
          cwd: target[0].cwd,
          workspaceId: target[0].workspaceId,
          model: primarySpec.model,
          modeId: primarySpec.modeId,
          thinkingOptionId: primarySpec.thinkingOptionId,
          featureValues: primarySpec.featureValues,
          archiveOnFinish: false,
          labels: Object.entries(stepRunLabels(identifier.taskId, step.id, runId)).map(
            ([key, value]) => `${key}=${value}`,
          ),
        },
      },
    });
    await this.taskService.mutateStep({
      ...identifier,
      mutate: (current) => ({
        ...current,
        runs: [
          ...current.runs,
          {
            id: runId,
            startedAt: this.now().toISOString(),
            endedAt: null,
            status: "running",
            agentIds: [],
            workspaceIds: [target[0].workspaceId],
            scheduleId: schedule.id,
            error: null,
          },
        ],
      }),
    });
  }

  /** ScheduleService owns the clock and provider run; this engine owns the
   * workflow row and task attachment. Lifecycle events join those two records
   * without polling or treating a schedule as a second workflow engine. */
  async handleScheduleRunLifecycle(event: ScheduleRunLifecycleEvent): Promise<void> {
    const scheduled = await this.findScheduledStep(event.scheduleId);
    if (!scheduled) return;
    if (event.type === "before_run" || event.type === "before_agent_start") {
      await this.taskService.assertTaskClaimable(scheduled.taskId);
      await this.taskService.assertTaskExecutable(scheduled.taskId);
      return;
    }
    if (event.type === "agent_started") {
      await this.taskService.attachAgent({
        taskId: scheduled.taskId,
        agentId: event.agentId,
        workspaceId: event.workspaceId,
        completionOwner: "workflow",
      });
      await this.taskService.mutateStep({
        taskId: scheduled.taskId,
        stepId: scheduled.stepId,
        mutate: (current) => ({
          ...current,
          runs: current.runs.map((run) =>
            run.id === scheduled.runId
              ? { ...run, agentIds: [...new Set([...run.agentIds, event.agentId])] }
              : run,
          ),
        }),
      });
      return;
    }
    const { steps: updatedSteps } = await this.taskService.mutateStep({
      taskId: scheduled.taskId,
      stepId: scheduled.stepId,
      mutate: (current) => ({
        ...current,
        runs: current.runs.map((run) =>
          run.id === scheduled.runId
            ? {
                ...run,
                status: event.status,
                endedAt: event.endedAt,
                agentIds:
                  event.agentId && !run.agentIds.includes(event.agentId)
                    ? [...run.agentIds, event.agentId]
                    : run.agentIds,
                error: event.error,
              }
            : run,
        ),
      }),
    });
    if (event.status === "succeeded") {
      await this.afterStepSettled(scheduled.taskId, updatedSteps, scheduled.stepIndex);
    }
  }

  private async findScheduledStep(scheduleId: string): Promise<{
    taskId: string;
    stepId: string;
    stepIndex: number;
    runId: string;
  } | null> {
    for (const workflow of await this.taskService.listWorkflows()) {
      for (const [stepIndex, step] of workflow.steps.entries()) {
        const run = step.runs.find((candidate) => candidate.scheduleId === scheduleId);
        if (run) {
          return { taskId: workflow.taskId, stepId: step.id, stepIndex, runId: run.id };
        }
      }
    }
    return null;
  }

  /** The folder the task's work belongs in, whether or not Git backs it. */
  private async resolveTaskWorkCwd(taskId: string): Promise<string> {
    const task = await this.taskService.getTask(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }
    const project = await this.taskService.getProject(task.projectId);
    if (project?.paseoProjectId) {
      return this.getProjectRootCwd(project.paseoProjectId);
    }
    for (const link of await this.taskService.listTaskAgents(taskId)) {
      const workspace = await this.getWorkspace(link.workspaceId);
      if (workspace && !workspace.archivedAt) {
        return workspace.cwd;
      }
    }
    throw new Error(
      `Task ${taskId} has no folder to work in: link its board to a project, or start the task from a workspace`,
    );
  }

  /**
   * The task's Git delivery boundary, or null when the folder cannot provide
   * one. A folder outside Git, or a repository whose first commit does not exist
   * yet, still hosts agent work — it just cannot carry a branch per task.
   */
  private async resolveTaskGitBase(
    taskId: string,
    requestedBaseBranch?: string,
  ): Promise<{ cwd: string; baseBranch: string } | null> {
    const cwd = await this.resolveTaskWorkCwd(taskId);
    if (!(await this.taskGit.isRepository(cwd))) return null;
    if (!(await this.taskGit.hasCommits(cwd))) return null;
    return { cwd, baseBranch: await this.ensureTaskIntegrationBranch(taskId, requestedBaseBranch) };
  }

  /** Reuses the task's own folder workspace, opening it the first time. */
  private async resolveDirectoryTarget(taskId: string, prompt: string): Promise<AgentTarget> {
    const cwd = await this.resolveTaskWorkCwd(taskId);
    const existing = await this.resolveExistingTaskWorkspace(taskId);
    if (existing && existing.cwd === cwd) {
      return existing;
    }
    const workspace = await this.createDirectoryWorkspace({
      cwd,
      firstAgentContext: { prompt },
    });
    return { cwd: workspace.cwd, workspaceId: workspace.workspaceId };
  }

  /** Assigns one stable ref to the task. Agent branches can come and go; this
   * ref is the delivery boundary every run merges into. */
  async ensureTaskIntegrationBranch(taskId: string, requestedBaseBranch?: string): Promise<string> {
    const inFlight = this.integrationBranchPromises.get(taskId);
    if (inFlight) return inFlight;
    const promise = this.createTaskIntegrationBranch(taskId, requestedBaseBranch).finally(() => {
      this.integrationBranchPromises.delete(taskId);
    });
    this.integrationBranchPromises.set(taskId, promise);
    return promise;
  }

  private async createTaskIntegrationBranch(
    taskId: string,
    requestedBaseBranch?: string,
  ): Promise<string> {
    const task = await this.taskService.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    const cwd = await this.resolveTaskWorkCwd(taskId);
    if (task.integration?.branch) {
      if (!(await this.taskGit.branchExists(cwd, task.integration.branch))) {
        throw new Error(`Task branch is missing: ${task.integration.branch}`);
      }
      return task.integration.branch;
    }
    const project = await this.taskService.getProject(task.projectId);
    if (!project) throw new Error(`Task project not found: ${task.projectId}`);
    const baseBranch = task.parentTaskId
      ? await this.ensureTaskIntegrationBranch(task.parentTaskId)
      : (requestedBaseBranch ?? (await this.taskGit.resolveDefaultBranch(cwd)));
    const branch = `paseo/tasks/${project.prefix.toLowerCase()}-${task.number}`;
    if (!(await this.taskGit.branchExists(cwd, branch))) {
      await this.taskGit.createBranch(cwd, branch, baseBranch);
    }
    await this.taskService.updateTask({
      taskId,
      integration: {
        branch,
        status: task.parentTaskId ? "pending" : "not_applicable",
        error: null,
      },
    });
    return branch;
  }

  /** Commits each worker workspace and merges it into the task's durable ref.
   * Repeating this is safe: already merged branches are a Git no-op. */
  async integrateTaskWork(taskId: string): Promise<void> {
    const task = await this.taskService.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    const workers = (await this.taskService.listTaskAgents(taskId)).filter(
      (link) => (link.role ?? "worker") === "worker",
    );
    // Tracker-only work has no Git delivery boundary. A branch is created when
    // the first code agent starts, not when a human checks off a plain task.
    if (!task.integration && workers.length === 0) return;
    if (!task.integration) {
      const project = await this.taskService.getProject(task.projectId);
      if (!project?.paseoProjectId) {
        let hasGitWorker = false;
        for (const worker of workers) {
          const workspace = await this.getWorkspace(worker.workspaceId);
          if (workspace && (await this.taskGit.isRepository(workspace.cwd))) {
            hasGitWorker = true;
            break;
          }
        }
        if (!hasGitWorker) return;
      }
    }
    const gitBase = await this.resolveTaskGitBase(taskId);
    // Work done in a folder Git cannot back is already where the person can see
    // it; there is no branch to merge it into.
    if (!gitBase) return;
    const branch = gitBase.baseBranch;
    const seenWorkspaces = new Set<string>();
    try {
      for (const worker of workers) {
        if (seenWorkspaces.has(worker.workspaceId)) continue;
        seenWorkspaces.add(worker.workspaceId);
        const workspace = await this.getWorkspace(worker.workspaceId);
        if (!workspace || workspace.archivedAt) {
          throw new Error(`Worker workspace is unavailable: ${worker.workspaceId}`);
        }
        await this.withIntegrationBranchLock(branch, () =>
          this.taskGit.integrateWorkspace(workspace.cwd, branch, `Integrate task ${task.title}`),
        );
      }
      await this.taskService.updateTask({
        taskId,
        integration: {
          branch,
          status: task.parentTaskId ? "pending" : "not_applicable",
          error: null,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.taskService.updateTask({
        taskId,
        integration: { branch, status: "conflicted", error: message },
      });
      throw error;
    }
  }

  /** A child is delivered only after its canonical ref merges into its
   * parent's canonical ref. Root tasks have no parent delivery boundary. */
  async integrateTaskIntoParent(taskId: string): Promise<void> {
    await this.integrateTaskWork(taskId);
    const task = await this.taskService.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    if (!task.integration) return;
    if (!task.parentTaskId) return;
    const parentBranch = await this.ensureTaskIntegrationBranch(task.parentTaskId);
    const sourceBranch = task.integration.branch;
    const cwd = await this.resolveTaskWorkCwd(taskId);
    try {
      await this.withIntegrationBranchLock(parentBranch, () =>
        this.taskGit.integrateBranch(
          cwd,
          sourceBranch,
          parentBranch,
          `Integrate subtask ${task.title}`,
        ),
      );
      await this.taskService.updateTask({
        taskId,
        integration: { branch: sourceBranch, status: "integrated", error: null },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.taskService.updateTask({
        taskId,
        integration: {
          branch: sourceBranch,
          status: "conflicted",
          error: message,
        },
      });
      throw error;
    }
  }

  /** Sibling subtasks can finish in parallel, but Git cannot check out and
   * update their shared parent ref from two temporary worktrees at once. Queue
   * only operations targeting the same canonical branch. */
  private async withIntegrationBranchLock<T>(
    branch: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.integrationBranchTails.get(branch) ?? Promise.resolve();
    let release = (): void => undefined;
    const turn = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => turn);
    this.integrationBranchTails.set(branch, tail);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.integrationBranchTails.get(branch) === tail) {
        this.integrationBranchTails.delete(branch);
      }
    }
  }

  /** Gives an integration conflict back to the latest worker. The failed Git
   * merge has already been aborted, so the agent resolves it on its own branch
   * and completion retries the same integration gate. */
  async requestIntegrationFix(input: { taskId: string; error: string }): Promise<void> {
    if (!this.resumeAgent) return;
    const task = await this.taskService.getTask(input.taskId);
    if (!task?.integration) return;
    const worker = (await this.taskService.listTaskAgents(input.taskId))
      .toReversed()
      .find((link) => (link.role ?? "worker") === "worker");
    if (!worker) return;
    const briefing = await this.buildBriefing({
      taskId: input.taskId,
      role: "integration_fixer",
    });
    await this.resumeAgent({
      agentId: worker.agentId,
      prompt: extendTaskAgentBriefing(
        briefing,
        [
          `Integration for task ${task.title} could not complete.`,
          `Canonical task branch: ${task.integration.branch}`,
          `Git reported: ${input.error}`,
          "Merge the latest canonical base into this workspace, resolve every conflict, verify the result, and finish again.",
        ].join("\n"),
      ),
    });
  }

  private async buildBriefing(input: {
    taskId: string;
    role: TaskAgentBriefingRole;
    step?: TaskAgentBriefingStep;
  }): Promise<string> {
    return await buildTaskAgentBriefing({
      taskService: this.taskService,
      taskId: input.taskId,
      role: input.role,
      toolsAvailable: this.agentManager.getMcpBaseUrl() !== null,
      ...(input.step ? { step: input.step } : {}),
    });
  }

  private async buildTaskWorkPrompt(input: {
    taskId: string;
    instructions: string;
    role: "worker" | "workflow_step";
    step?: TaskAgentBriefingStep;
  }): Promise<string> {
    const task = await this.taskService.getTask(input.taskId);
    if (!task) {
      throw new Error(`Task not found: ${input.taskId}`);
    }
    const project = await this.taskService.getProject(task.projectId);
    if (!project) {
      throw new Error(`Task project not found: ${task.projectId}`);
    }
    const briefing = await this.buildBriefing(input);
    return buildWorkPrompt({
      briefing,
      task,
      projectPrefix: project.prefix,
      instructions: input.instructions,
    });
  }

  /**
   * A subtask's work starts from its parent's branch, not from main: the two
   * stack, and the subtask's diff is reviewable on its own instead of carrying
   * everything the parent already did.
   *
   * The parent's branch is the one its own worktree is on. A parent with no
   * worktree yet has nothing to stack onto, and the subtask starts from the
   * default branch like any other work.
   */
  /**
   * Start work on a card from a preset: one agent, attached, in the environment
   * the preset asks for. This is the short path a workflow makes long — the
   * preset is a one-step workflow you do not have to author.
   *
   * The attachment goes through the tracker, so a task whose blockers are still
   * open refuses it before an agent is created rather than after.
   */
  async delegate(input: {
    taskId: string;
    presetId?: string;
    agent?: TaskDelegateSpec;
  }): Promise<{ agentId: string }> {
    const preset = await this.resolveDelegateSpec(input);
    const task = await this.taskService.getTask(input.taskId);
    if (!task) {
      throw new Error(`Task not found: ${input.taskId}`);
    }
    await this.taskService.assertTaskClaimable(input.taskId);
    await this.taskService.assertTaskExecutable(input.taskId);
    const project = await this.taskService.getProject(task.projectId);
    if (!project) {
      throw new Error(`Task project not found: ${task.projectId}`);
    }

    const prompt = await this.buildTaskWorkPrompt({
      taskId: input.taskId,
      instructions: preset.instructions,
      role: "worker",
    });
    return this.startAgentOnTask({
      taskId: input.taskId,
      preset,
      prompt,
      title: task.title,
      allowAggregate: false,
    });
  }

  /** Creates the agent, then commits the attachment — and undoes the agent and
   * any worktree it was given when the attachment is refused, so a card that
   * cannot be claimed does not leave a process running against it. */
  private async startAgentOnTask(input: {
    taskId: string;
    preset: Pick<
      ResolvedDelegateSpec,
      | "id"
      | "provider"
      | "model"
      | "modeId"
      | "thinkingOptionId"
      | "featureValues"
      | "environmentKind"
      | "baseBranch"
    >;
    prompt: string;
    title: string;
    allowAggregate: boolean;
  }): Promise<{ agentId: string }> {
    const target = await this.resolveDelegateTarget(input.taskId, input.preset, input.prompt);
    const created = await this.createAgent({
      kind: "mcp",
      provider: formatProviderModel(
        input.preset.provider as StepAgentSpec["provider"],
        input.preset.model ?? undefined,
      ),
      title: input.title,
      initialPrompt: input.prompt,
      cwd: target.cwd,
      workspaceId: target.workspaceId,
      mode: input.preset.modeId ?? undefined,
      thinking: input.preset.thinkingOptionId ?? undefined,
      features: input.preset.featureValues,
      unattended: false,
      promptFailure: "return-error",
      background: true,
      notifyOnFinish: false,
    });

    try {
      if (created.initialPromptError) {
        throw created.initialPromptError;
      }
      await this.taskService.attachAgent({
        taskId: input.taskId,
        agentId: created.snapshot.id,
        workspaceId: target.workspaceId,
        presetId: input.preset.id,
        ...(input.allowAggregate ? { allowAggregate: true } : {}),
      });
    } catch (error) {
      await this.cancelCreatedAgent(created.snapshot.id);
      if (target.createdForRun) {
        try {
          await this.archiveWorkspace(target.workspaceId);
        } catch (archiveError) {
          this.logger.warn(
            { err: archiveError, workspaceId: target.workspaceId },
            "Failed to archive an unused delegation workspace",
          );
        }
      }
      throw error;
    }
    return { agentId: created.snapshot.id };
  }

  /**
   * Where a delegated agent runs. `project_default` means "where this card is
   * already being worked" — the workspace an agent on it is using. A card with
   * nobody on it yet has no such place, so it gets a worktree like the other
   * mode: an agent has to run somewhere, and the project root is not a
   * workspace this daemon can attach to.
   */
  /**
   * A saved preset, or a one-off description of the same thing. Both end up as
   * the same shape so the rest of the path cannot tell them apart — a run
   * started ad hoc is not a lesser kind of run.
   */
  private async resolveDelegateSpec(input: {
    presetId?: string;
    agent?: TaskDelegateSpec;
  }): Promise<ResolvedDelegateSpec> {
    if (input.presetId) {
      const preset = await this.taskService.getPreset(input.presetId);
      if (!preset) {
        throw new Error(`Preset not found: ${input.presetId}`);
      }
      return preset;
    }
    if (!input.agent) {
      throw new Error("Starting work needs either a preset or an agent to run as");
    }
    return {
      id: null,
      provider: input.agent.provider,
      model: input.agent.model ?? null,
      modeId: input.agent.modeId ?? null,
      thinkingOptionId: input.agent.thinkingOptionId ?? null,
      featureValues: input.agent.featureValues,
      instructions: input.agent.instructions ?? "",
      environmentKind: input.agent.environmentKind ?? "new_worktree",
      baseBranch: null,
    };
  }

  private async resolveDelegateTarget(
    taskId: string,
    preset: { environmentKind: "project_default" | "new_worktree"; baseBranch: string | null },
    prompt: string,
  ): Promise<AgentTarget> {
    const task = await this.taskService.getTask(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }
    const workspacePolicy = (await this.resolveEffectivePolicy(task)).workspace;
    let environmentKind = preset.environmentKind;
    if (workspacePolicy === "dedicated") {
      environmentKind = "new_worktree";
    } else if (workspacePolicy === "reuse") {
      environmentKind = "project_default";
    }
    if (environmentKind === "project_default") {
      const existing = await this.resolveExistingTaskWorkspace(taskId);
      if (existing) {
        await this.resolveTaskGitBase(taskId, preset.baseBranch ?? undefined);
        return existing;
      }
    }
    const gitBase = await this.resolveTaskGitBase(taskId, preset.baseBranch ?? undefined);
    if (!gitBase) {
      return this.resolveDirectoryTarget(taskId, prompt);
    }
    const created = await this.createWorktreeWorkspace({
      cwd: gitBase.cwd,
      firstAgentContext: { prompt },
      refName: gitBase.baseBranch,
    });
    return {
      cwd: created.workspace.cwd,
      workspaceId: created.workspace.workspaceId,
      createdForRun: true,
    };
  }

  /**
   * Puts a fresh agent on a card that has reached review.
   *
   * It is a new agent on purpose. The one reliable multi-agent pattern is a
   * verifier with no implementation context: an agent asked to check its own
   * work gives the same judgement that produced the work, asked twice. This one
   * inherits nothing but the card and the checkout, and it attaches as a
   * reviewer so the tracker will accept its verdict and refuse the workers'.
   *
   * It runs in a fresh checkout of the task's canonical branch. That branch is
   * the consolidated result when several workers fan out, while any one worker
   * checkout may contain only its own part.
   */
  async requestReview(taskId: string): Promise<{ agentId: string } | null> {
    const task = await this.taskService.getTask(taskId);
    if (!task) {
      return null;
    }
    const project = await this.taskService.getProject(task.projectId);
    if (!project) {
      return null;
    }
    const presetId = (await this.resolveEffectivePolicy(task)).reviewerPresetId;
    if (!presetId) {
      return null;
    }
    if (!this.agentManager.getMcpBaseUrl()) {
      // A reviewer records its verdict through the daemon's MCP tools. Without
      // them the run can only end in a chat nobody reads, so the card is left in
      // review for a human instead of burning a whole review.
      throw new Error(
        "reviews need the daemon's agent MCP tools; enable mcp.injectIntoAgents to let a reviewer record a verdict",
      );
    }
    const preset = await this.taskService.getPreset(presetId);
    if (!preset) {
      // Distinct from "this board reviews by hand": somebody asked for an agent
      // reviewer and is not getting one.
      throw new Error(`The reviewer preset ${presetId} no longer exists`);
    }
    const children = await this.taskService.listSubtasks(taskId);
    const briefing = await this.buildBriefing({ taskId, role: "reviewer" });
    const prompt =
      children.length > 0
        ? buildAggregateReviewPrompt({
            briefing,
            task,
            projectPrefix: project.prefix,
            instructions: preset.instructions,
            childVerdicts: await this.collectChildVerdicts({
              projectId: task.projectId,
              projectPrefix: project.prefix,
              children,
            }),
          })
        : buildReviewPrompt({
            briefing,
            task,
            projectPrefix: project.prefix,
            instructions: preset.instructions,
          });
    const gitBase = await this.resolveTaskGitBase(taskId);
    // Without a branch there is no separate checkout to review; the reviewer
    // reads the same folder the work happened in.
    const workspace = gitBase
      ? await this.createWorktreeWorkspace({
          cwd: gitBase.cwd,
          refName: gitBase.baseBranch,
          firstAgentContext: { prompt },
        }).then((created) => ({
          cwd: created.workspace.cwd,
          workspaceId: created.workspace.workspaceId,
        }))
      : await this.resolveDirectoryTarget(taskId, prompt);

    let createdAgentId: string | null = null;
    try {
      const created = await this.createAgent({
        kind: "mcp",
        provider: formatProviderModel(
          preset.provider as StepAgentSpec["provider"],
          preset.model ?? undefined,
        ),
        title: `Review ${task.title}`,
        initialPrompt: prompt,
        cwd: workspace.cwd,
        workspaceId: workspace.workspaceId,
        mode: preset.modeId ?? undefined,
        thinking: preset.thinkingOptionId ?? undefined,
        features: preset.featureValues,
        unattended: true,
        promptFailure: "return-error",
        background: true,
        notifyOnFinish: false,
      });
      createdAgentId = created.snapshot.id;
      if (created.initialPromptError) {
        throw created.initialPromptError;
      }
      await this.taskService.attachAgent({
        taskId,
        agentId: created.snapshot.id,
        workspaceId: workspace.workspaceId,
        presetId: preset.id,
        role: "reviewer",
      });
      return { agentId: created.snapshot.id };
    } catch (error) {
      if (createdAgentId) await this.cancelCreatedAgent(createdAgentId);
      await this.archiveWorkspace(workspace.workspaceId).catch(() => undefined);
      throw error;
    }
  }

  /**
   * How each subtask was judged, read back out of the board's feed. The feed is
   * where every verdict was recorded, so there is no second store of review
   * outcomes to keep in step with it.
   */
  private async collectChildVerdicts(input: {
    projectId: string;
    projectPrefix: string;
    children: readonly Task[];
  }): Promise<string[]> {
    const childrenById = new Map(input.children.map((child) => [child.id, child]));
    const verdicts = new Map<string, string>();
    for (const entry of await this.taskService.listBoardFeed({ projectId: input.projectId })) {
      // The board writes verdicts in its own voice, unattributed. An entry
      // carrying an agent id quotes an agent — a stalled worker, a reviewer's
      // last message — and its prose must not be read back as a verdict.
      if (
        !entry.taskId ||
        !childrenById.has(entry.taskId) ||
        entry.kind !== "system" ||
        entry.agentId
      ) {
        continue;
      }
      if (isReviewVerdictEvent(entry.event)) {
        verdicts.set(entry.taskId, entry.body);
      }
    }
    return input.children.map((child) => {
      const recorded = verdicts.get(child.id);
      return (
        recorded ??
        `${input.projectPrefix}-${child.number} "${child.title}" reached ${child.status} with no review verdict recorded.`
      );
    });
  }

  /**
   * A rejected review goes back to every worker attached to the card, each in
   * its own checkout. Resuming only the newest one is wrong the moment a task
   * fans out: the review judged the integrated branch, so findings can belong to
   * any of the workers that fed it, and the ones left out would settle again
   * unchanged.
   *
   * The transition engine observes the new turns and sends the result through a
   * fresh review once they have all stopped.
   */
  async requestCorrection(input: {
    taskId: string;
    feedback: string | null;
  }): Promise<{ agentIds: string[] } | null> {
    if (!this.resumeAgent) {
      return null;
    }
    const task = await this.taskService.getTask(input.taskId);
    if (!task) {
      return null;
    }
    const project = await this.taskService.getProject(task.projectId);
    if (!project) {
      return null;
    }
    if ((await this.taskService.countSubtasks(input.taskId)) > 0) {
      return this.correctAggregate({ task, project, feedback: input.feedback });
    }
    const workers = new Map<string, TaskAgentLink>();
    for (const link of await this.taskService.listTaskAgents(input.taskId)) {
      if ((link.role ?? "worker") === "worker") {
        workers.set(link.agentId, link);
      }
    }
    if (workers.size === 0) {
      return null;
    }
    const feedback =
      input.feedback ??
      "The review rejected the current change. Read the task feed for the findings.";
    const briefing = await this.buildBriefing({ taskId: input.taskId, role: "corrector" });
    const prompt = extendTaskAgentBriefing(
      briefing,
      [
        `Review rejected ${project.prefix}-${task.number}.`,
        `Task ID: ${task.id}`,
        `Title: ${task.title}`,
        "",
        feedback,
        "",
        "Correct the implementation in this workspace. Comment on the task with what changed when finished.",
      ].join("\n"),
    );

    const resumed: string[] = [];
    const failures: unknown[] = [];
    for (const worker of workers.values()) {
      await this.taskService.attachAgent({
        taskId: input.taskId,
        agentId: worker.agentId,
        workspaceId: worker.workspaceId,
        presetId: worker.presetId,
        role: "worker",
        completionOwner: "attachment",
      });
      try {
        await this.resumeAgent({ agentId: worker.agentId, prompt });
        resumed.push(worker.agentId);
      } catch (error) {
        await this.taskService.attachAgent({
          taskId: input.taskId,
          agentId: worker.agentId,
          workspaceId: worker.workspaceId,
          presetId: worker.presetId,
          role: worker.role ?? "worker",
          completionOwner: worker.completionOwner ?? "attachment",
        });
        failures.push(error);
      }
    }
    if (resumed.length === 0) {
      throw failures[0] ?? new Error("No attached worker could be resumed for the correction");
    }
    for (const error of failures) {
      this.logger.warn(
        { err: error, taskId: input.taskId },
        "A worker could not be resumed for the correction; the others were",
      );
    }
    return { agentIds: resumed };
  }

  /**
   * A rejected final review corrects on the branch it judged — the aggregate's
   * own. The most recent worker whose checkout still exists is resumed there;
   * when none can be, a fresh corrector is started on that branch. Subtasks
   * already in Done are never reopened: their work is merged, and the finding
   * belongs to the integration, not to a diff that was already judged.
   */
  private async correctAggregate(input: {
    task: Task;
    project: { prefix: string };
    feedback: string | null;
  }): Promise<{ agentIds: string[] } | null> {
    const prompt = await this.buildAggregateCorrectionPrompt(input);
    const workers = (await this.taskService.listTaskAgents(input.task.id))
      .toReversed()
      .filter((link) => (link.role ?? "worker") === "worker");
    if (this.resumeAgent) {
      for (const worker of workers) {
        const workspace = await this.getWorkspace(worker.workspaceId);
        if (!workspace || workspace.archivedAt) {
          continue;
        }
        await this.taskService.attachAgent({
          taskId: input.task.id,
          agentId: worker.agentId,
          workspaceId: worker.workspaceId,
          presetId: worker.presetId,
          role: "worker",
          completionOwner: "attachment",
          allowAggregate: true,
        });
        await this.resumeAgent({ agentId: worker.agentId, prompt });
        return { agentIds: [worker.agentId] };
      }
    }
    const presetId =
      input.task.executionSpec?.presetId ??
      workers.find((worker) => worker.presetId)?.presetId ??
      null;
    if (!presetId) {
      return null;
    }
    const preset = await this.taskService.getPreset(presetId);
    if (!preset) {
      return null;
    }
    const started = await this.startAgentOnTask({
      taskId: input.task.id,
      preset,
      prompt,
      title: `Correct ${input.task.title}`,
      allowAggregate: true,
    });
    return { agentIds: [started.agentId] };
  }

  private async buildAggregateCorrectionPrompt(input: {
    task: Task;
    project: { prefix: string };
    feedback: string | null;
  }): Promise<string> {
    const feedback =
      input.feedback ??
      "The final review rejected the integrated result. Read the board feed for the findings.";
    const briefing = await this.buildBriefing({ taskId: input.task.id, role: "corrector" });
    return extendTaskAgentBriefing(
      briefing,
      [
        `The final review rejected ${input.project.prefix}-${input.task.number}.`,
        `Task ID: ${input.task.id}`,
        `Title: ${input.task.title}`,
        "",
        feedback,
        "",
        "This workspace is on the task's own branch, which already carries every subtask's merged work. Correct the integrated result here; the subtasks that are Done stay done.",
        "Comment on the task with what changed when finished.",
      ].join("\n"),
    );
  }

  /**
   * Lets go of a reviewer that has stopped. A review checkout is a worktree the
   * daemon made for one judgement on the task branch: keeping it leaves dead
   * worktrees on disk and makes the card's newest workspace the reviewer's
   * rather than a worker's. The findings live in the feed, not in the checkout.
   */
  async releaseReviewer(input: {
    taskId: string;
    agentId: string;
    cancelAgent: boolean;
  }): Promise<void> {
    const links = await this.taskService.listTaskAgents(input.taskId);
    const reviewer = links.find(
      (link) => link.agentId === input.agentId && (link.role ?? "worker") === "reviewer",
    );
    if (!reviewer) {
      return;
    }
    if (input.cancelAgent) {
      await this.cancelCreatedAgent(input.agentId);
    }
    const sharedWithAnotherAgent = links.some(
      (link) => link.workspaceId === reviewer.workspaceId && link.agentId !== reviewer.agentId,
    );
    if (sharedWithAnotherAgent) {
      return;
    }
    try {
      const workspace = await this.getWorkspace(reviewer.workspaceId);
      if (workspace && !workspace.archivedAt && workspace.isPaseoOwnedWorktree) {
        await this.archiveWorkspace(reviewer.workspaceId);
      }
    } catch (error) {
      this.logger.warn(
        { err: error, workspaceId: reviewer.workspaceId },
        "Failed to archive a review workspace",
      );
    }
  }

  private async resolveExistingTaskWorkspace(taskId: string): Promise<AgentTarget | null> {
    for (const link of await this.taskService.listTaskAgents(taskId)) {
      const workspace = await this.getWorkspace(link.workspaceId);
      if (workspace && !workspace.archivedAt) {
        return { cwd: workspace.cwd, workspaceId: workspace.workspaceId };
      }
    }
    return null;
  }

  private async resolveTargetsForStep(
    identifier: TaskStepIdentifier,
    steps: Step[],
    stepIndex: number,
    agentCount: number,
    firstAgentPrompt: string,
  ): Promise<AgentTarget[]> {
    const step = steps[stepIndex];
    switch (step.workspace.mode) {
      case "existing": {
        const workspace = await this.getWorkspace(step.workspace.workspaceId);
        if (!workspace || workspace.archivedAt) {
          throw new Error(`Workspace not found: ${step.workspace.workspaceId}`);
        }
        await this.resolveTaskGitBase(identifier.taskId, workspace.branch ?? undefined);
        return Array.from({ length: agentCount }, () => ({
          cwd: workspace.cwd,
          workspaceId: workspace.workspaceId,
        }));
      }
      case "worktree": {
        // One checkout, several writers, is a race the engine would be handing
        // out rather than a configuration. `worktree_per_agent` exists for
        // exactly this, so say so instead of letting them collide.
        if (agentCount > 1) {
          throw new Error(
            `Step ${step.id} fans out to ${agentCount} agents but shares one worktree; use worktree_per_agent`,
          );
        }
        const gitBase = await this.resolveTaskGitBase(identifier.taskId);
        if (!gitBase) {
          const target = await this.resolveDirectoryTarget(identifier.taskId, firstAgentPrompt);
          return Array.from({ length: agentCount }, () => target);
        }
        const created = await this.createWorktreeWorkspace({
          cwd: gitBase.cwd,
          firstAgentContext: { prompt: firstAgentPrompt },
          refName: gitBase.baseBranch,
        });
        return Array.from({ length: agentCount }, () => ({
          cwd: created.workspace.cwd,
          workspaceId: created.workspace.workspaceId,
        }));
      }
      case "worktree_per_agent": {
        const gitBase = await this.resolveTaskGitBase(identifier.taskId);
        // Several agents can only be kept apart by separate checkouts, and
        // separate checkouts need Git. Sharing one folder would be a race.
        if (!gitBase) {
          throw new Error(
            `Step ${step.id} gives each of its ${agentCount} agents its own worktree, which needs a Git repository with at least one commit. Commit the project first, or run the step with one agent.`,
          );
        }
        const targets: AgentTarget[] = [];
        for (let i = 0; i < agentCount; i++) {
          const created = await this.createWorktreeWorkspace({
            cwd: gitBase.cwd,
            firstAgentContext: { prompt: firstAgentPrompt },
            refName: gitBase.baseBranch,
          });
          targets.push({ cwd: created.workspace.cwd, workspaceId: created.workspace.workspaceId });
        }
        return targets;
      }
      case "reuse_previous": {
        if (stepIndex === 0) {
          throw new Error(`Step ${step.id} cannot reuse_previous: it has no previous step`);
        }
        const previous = steps[stepIndex - 1];
        if (previous.workspace.mode === "worktree_per_agent") {
          throw new Error(
            `Step ${step.id} cannot reuse_previous after step ${previous.id} (worktree_per_agent is ambiguous) — use existing or worktree`,
          );
        }
        const previousRun = latestRunOf(previous);
        const workspaceId = previousRun?.workspaceIds[0];
        if (!workspaceId) {
          throw new Error(`Step ${step.id} cannot reuse_previous: step ${previous.id} has no run`);
        }
        const workspace = await this.getWorkspace(workspaceId);
        if (!workspace || workspace.archivedAt) {
          throw new Error(`Workspace not found: ${workspaceId}`);
        }
        return Array.from({ length: agentCount }, () => ({
          cwd: workspace.cwd,
          workspaceId: workspace.workspaceId,
        }));
      }
    }
  }

  private async resolveTargetsFromWorkspaceIds(
    workspaceIds: string[],
    agentCount: number,
  ): Promise<AgentTarget[]> {
    if (workspaceIds.length === 0) {
      throw new Error("Cannot retry: previous run recorded no workspaces");
    }
    const resolved: AgentTarget[] = [];
    for (let i = 0; i < agentCount; i++) {
      const workspaceId = workspaceIds[Math.min(i, workspaceIds.length - 1)];
      const workspace = await this.getWorkspace(workspaceId);
      if (!workspace || workspace.archivedAt) {
        throw new Error(`Workspace not found: ${workspaceId}`);
      }
      resolved.push({ cwd: workspace.cwd, workspaceId: workspace.workspaceId });
    }
    return resolved;
  }

  /**
   * A slot is taken from the moment a dispatch commits to it, not from the
   * moment its tracker exists. Registering the tracker happens after the
   * workspaces are resolved and the agents are created, and two dispatches
   * racing through that gap would both read the same free slot.
   */
  private hasFreeSlot(): boolean {
    return this.runTrackers.size + this.reservedRunIds.size < this.maxConcurrentRuns;
  }

  /**
   * Records a run the host is not ready to start. The row is the queue: it
   * survives a restart, which an in-memory list of pending callbacks would not,
   * and a run that vanished on restart would leave a card waiting on work
   * nobody is going to do.
   */
  private async enqueueRun(
    identifier: TaskStepIdentifier,
    reuseWorkspaceIds: string[] | null,
  ): Promise<Step> {
    const now = this.now().toISOString();
    const { step } = await this.taskService.mutateStep({
      ...identifier,
      mutate: (current) => ({
        ...current,
        runs: [
          ...current.runs,
          {
            id: randomUUID(),
            startedAt: now,
            endedAt: null,
            status: "queued",
            agentIds: [],
            workspaceIds: reuseWorkspaceIds ?? [],
            scheduleId: null,
            error: null,
          },
        ],
      }),
    });
    return step;
  }

  /**
   * Starts as many queued runs as there is room for, oldest first. Called
   * whenever a slot frees and once at boot, so a queue left by a crash is not
   * a queue nobody looks at again.
   */
  async drainQueue(): Promise<void> {
    if (this.draining || !(await this.taskService.isAvailable())) {
      return;
    }
    this.draining = true;
    try {
      while (this.hasFreeSlot()) {
        const next = await this.findOldestQueuedRun();
        if (!next) {
          return;
        }
        await this.startQueuedRun(next).catch((error) => {
          this.logger.error(
            { err: error, taskId: next.taskId, stepId: next.stepId },
            "Failed to start a queued step run",
          );
        });
      }
    } finally {
      this.draining = false;
    }
  }

  private async findOldestQueuedRun(): Promise<{
    taskId: string;
    stepId: string;
    runId: string;
    startedAt: string;
    workspaceIds: string[];
  } | null> {
    const workflows = await this.taskService.listWorkflows();
    let oldest: {
      taskId: string;
      stepId: string;
      runId: string;
      startedAt: string;
      workspaceIds: string[];
    } | null = null;
    for (const workflow of workflows) {
      for (const step of workflow.steps) {
        const latest = latestRunOf(step);
        if (latest?.status !== "queued") {
          continue;
        }
        if (!oldest || latest.startedAt < oldest.startedAt) {
          oldest = {
            taskId: workflow.taskId,
            stepId: step.id,
            runId: latest.id,
            startedAt: latest.startedAt,
            workspaceIds: latest.workspaceIds,
          };
        }
      }
    }
    return oldest;
  }

  private async startQueuedRun(queued: {
    taskId: string;
    stepId: string;
    runId: string;
    workspaceIds: string[];
  }): Promise<void> {
    const steps = await this.requireSteps(queued.taskId);
    const stepIndex = requireStepIndex(steps, queued.stepId);
    // Drop the placeholder before dispatching: the real run replaces it, and
    // leaving both would show the step as having been attempted twice.
    await this.taskService.mutateStep({
      taskId: queued.taskId,
      stepId: queued.stepId,
      mutate: (current) => ({
        ...current,
        runs: current.runs.filter((run) => run.id !== queued.runId),
      }),
    });
    await this.dispatchRun(
      { taskId: queued.taskId, stepId: queued.stepId },
      steps,
      stepIndex,
      queued.workspaceIds.length > 0 ? queued.workspaceIds : null,
    );
  }

  /**
   * Continues the previous run's conversation for one agent slot. Null when
   * there is nothing to resume — no prior run, no resume support, no agent for
   * this slot, or an agent that can no longer take a prompt — and the caller
   * falls back to creating a fresh one.
   */
  private async tryResumeRunAgent(input: {
    taskId: string;
    resumeFrom: ResumeFromRun | null;
    agentIndex: number;
    stepPrompt: string;
    step: TaskAgentBriefingStep;
  }): Promise<string | null> {
    if (!input.resumeFrom || !this.resumeAgent) {
      return null;
    }
    const agentId = input.resumeFrom.agentIds[input.agentIndex];
    if (!agentId) {
      return null;
    }
    const reason = input.resumeFrom.error
      ? `it failed:\n${input.resumeFrom.error}`
      : "it did not finish";
    const briefing = await this.buildBriefing({
      taskId: input.taskId,
      role: "workflow_step",
      step: input.step,
    });
    const prompt = extendTaskAgentBriefing(
      briefing,
      [
        `This step is being retried because ${reason}`,
        "",
        "You already worked on this step in this same workspace. Address what stopped it and finish the step. The step asked for:",
        "",
        input.stepPrompt,
      ].join("\n"),
    );
    try {
      await this.resumeAgent({ agentId, prompt });
      return agentId;
    } catch (error) {
      this.logger.warn(
        { err: error, agentId },
        "Could not resume the previous run's agent; starting a fresh one",
      );
      return null;
    }
  }

  private async dispatchRun(
    identifier: TaskStepIdentifier,
    steps: Step[],
    stepIndex: number,
    reuseWorkspaceIds: string[] | null,
    resumeFrom: ResumeFromRun | null = null,
  ): Promise<Step> {
    await this.taskService.assertTaskClaimable(identifier.taskId);
    await this.taskService.assertTaskExecutable(identifier.taskId);
    if (!this.hasFreeSlot()) {
      // The queue row keeps only the workspaces: a retry that waits for a slot
      // starts fresh agents there rather than resuming a conversation that has
      // meanwhile gone stale.
      return this.enqueueRun(identifier, reuseWorkspaceIds);
    }
    const runId = randomUUID();
    this.reservedRunIds.add(runId);
    try {
      return await this.dispatchReservedRun(
        identifier,
        steps,
        stepIndex,
        reuseWorkspaceIds,
        runId,
        resumeFrom,
      );
    } finally {
      this.reservedRunIds.delete(runId);
    }
  }

  private async dispatchReservedRun(
    identifier: TaskStepIdentifier,
    steps: Step[],
    stepIndex: number,
    reuseWorkspaceIds: string[] | null,
    runId: string,
    resumeFrom: ResumeFromRun | null = null,
  ): Promise<Step> {
    const step = steps[stepIndex];
    const prompts = await Promise.all(
      step.agents.map((spec) =>
        this.buildTaskWorkPrompt({
          taskId: identifier.taskId,
          instructions: spec.promptOverride ?? step.prompt,
          role: "workflow_step",
          step: { name: step.name, index: stepIndex + 1, total: steps.length },
        }),
      ),
    );
    const targets = reuseWorkspaceIds
      ? await this.resolveTargetsFromWorkspaceIds(reuseWorkspaceIds, step.agents.length)
      : await this.resolveTargetsForStep(
          identifier,
          steps,
          stepIndex,
          step.agents.length,
          prompts[0],
        );

    const labels = stepRunLabels(identifier.taskId, step.id, runId);
    const agentIds: string[] = [];
    let creationError: string | null = null;

    for (let i = 0; i < step.agents.length; i++) {
      const spec = step.agents[i];
      const target = targets.length === 1 ? targets[0] : targets[i];
      const resumedAgentId = await this.tryResumeRunAgent({
        taskId: identifier.taskId,
        resumeFrom,
        agentIndex: i,
        stepPrompt: spec.promptOverride ?? step.prompt,
        step: { name: step.name, index: stepIndex + 1, total: steps.length },
      });
      if (resumedAgentId) {
        agentIds.push(resumedAgentId);
        continue;
      }
      try {
        const created = await this.createAgent({
          kind: "mcp",
          provider: formatProviderModel(spec.provider, spec.model),
          title: stepAgentTitle(step, spec, i),
          initialPrompt: prompts[i],
          cwd: target.cwd,
          workspaceId: target.workspaceId,
          mode: spec.modeId,
          thinking: spec.thinkingOptionId,
          features: spec.featureValues,
          labels,
          unattended: true,
          promptFailure: "return-error",
          background: true,
          notifyOnFinish: false,
        });
        agentIds.push(created.snapshot.id);
        if (created.initialPromptError) {
          creationError =
            created.initialPromptError instanceof Error
              ? created.initialPromptError.message
              : String(created.initialPromptError);
        }
      } catch (error) {
        creationError = error instanceof Error ? error.message : String(error);
        this.logger.error(
          { err: error, taskId: identifier.taskId, stepId: step.id },
          "Failed to create step-run agent",
        );
      }
    }

    const workspaceIds = Array.from(new Set(targets.map((target) => target.workspaceId)));
    const startCommit = step.requireChanges === true ? await readHeadCommit(targets[0].cwd) : null;
    const startedAt = this.now().toISOString();
    const initialStatus: StepRunStatus = agentIds.length === 0 ? "failed" : "running";
    const { step: updatedStep } = await this.taskService.mutateStep({
      ...identifier,
      mutate: (current) => ({
        ...current,
        runs: [
          ...current.runs,
          {
            id: runId,
            startedAt,
            endedAt: initialStatus === "failed" ? startedAt : null,
            status: initialStatus,
            agentIds,
            workspaceIds,
            scheduleId: null,
            startCommit,
            error:
              initialStatus === "failed" ? (creationError ?? "No agent could be created") : null,
          },
        ],
      }),
    });

    if (agentIds.length === 0) {
      return updatedStep;
    }

    try {
      await this.attachRunAgentsToTask(identifier.taskId, agentIds, targets);
    } catch (error) {
      for (const agentId of agentIds) {
        await this.cancelCreatedAgent(agentId);
      }
      const message = error instanceof Error ? error.message : String(error);
      const endedAt = this.now().toISOString();
      await this.taskService.mutateStep({
        ...identifier,
        mutate: (current) => ({
          ...current,
          runs: current.runs.map((run) =>
            run.id === runId ? { ...run, status: "failed" as const, endedAt, error: message } : run,
          ),
        }),
      });
      throw error;
    }
    this.trackRun(identifier, runId, agentIds, creationError, step.timeoutMs);
    return updatedStep;
  }

  /**
   * Records the dispatched agents on the task. The attachment carries no
   * completion observer: for workflow work the last step settling is the
   * signal, and a three-step workflow must not move the card on step one.
   */
  private async attachRunAgentsToTask(
    taskId: string,
    agentIds: string[],
    targets: AgentTarget[],
  ): Promise<void> {
    for (let i = 0; i < agentIds.length; i++) {
      const target = targets.length === 1 ? targets[0] : targets[i];
      await this.taskService.attachAgent({
        taskId,
        agentId: agentIds[i],
        workspaceId: target.workspaceId,
        completionOwner: "workflow",
      });
    }
  }

  private async cancelCreatedAgent(agentId: string): Promise<void> {
    try {
      await cancelAgentRunCommand(
        { agentManager: this.agentManager, logger: this.logger },
        agentId,
      );
    } catch (error) {
      this.logger.warn({ err: error, agentId }, "Failed to stop an agent the task no longer needs");
    }
  }

  /**
   * Stops a run that has outlived its step's ceiling. Without this an agent
   * that loops reads as running forever: nothing it does is an error, so no
   * observer fires, and the card waits on it indefinitely. The agents are
   * cancelled so the tokens stop too, not merely disowned.
   */
  private armRunTimeout(tracker: RunTracker, timeoutMs: number | undefined): void {
    if (!timeoutMs) {
      return;
    }
    tracker.timeout = setTimeout(() => {
      if (!this.runTrackers.has(tracker.runId)) {
        return;
      }
      void this.cancelRunAgents(tracker).finally(() => {
        void this.finishRun(
          tracker,
          "failed",
          `The step ran longer than its ${timeoutMs}ms limit and was stopped`,
        );
      });
    }, timeoutMs);
  }

  private async cancelRunAgents(tracker: RunTracker): Promise<void> {
    for (const agentId of tracker.pending) {
      try {
        await cancelAgentRunCommand(
          { agentManager: this.agentManager, logger: this.logger },
          agentId,
        );
      } catch (error) {
        this.logger.warn({ err: error, agentId }, "Failed to cancel a timed-out step-run agent");
      }
    }
  }

  private trackRun(
    identifier: TaskStepIdentifier,
    runId: string,
    agentIds: string[],
    initialError: string | null,
    timeoutMs?: number,
  ): void {
    const tracker: RunTracker = {
      identifier,
      runId,
      pending: new Set(agentIds),
      failedReason: initialError,
      unsubscribes: new Map(),
      timeout: null,
    };
    this.runTrackers.set(runId, tracker);
    this.armRunTimeout(tracker, timeoutMs);

    for (const agentId of agentIds) {
      const observer = observeAgentCompletion();
      const unsubscribe = this.agentManager.subscribe(
        (event) => {
          if (event.type !== "agent_state") {
            return;
          }
          const outcome = observer.observe({
            lifecycle: event.agent.lifecycle,
            hasPendingPermissions: event.agent.pendingPermissions.size > 0,
          });
          if (outcome) {
            this.settleTrackedAgent(runId, agentId, outcome);
          }
        },
        { agentId, replayState: false },
      );
      tracker.unsubscribes.set(agentId, unsubscribe);

      // Catch the race where the agent already reached a terminal lifecycle
      // before the subscription above was registered.
      const snapshot: ManagedAgent | null = this.agentManager.getAgent(agentId);
      const initialOutcome = observer.observe({
        lifecycle: snapshot?.lifecycle ?? "closed",
        hasPendingPermissions: (snapshot?.pendingPermissions.size ?? 0) > 0,
      });
      if (initialOutcome) {
        this.settleTrackedAgent(runId, agentId, initialOutcome);
      }
    }
  }

  private settleTrackedAgent(
    runId: string,
    agentId: string,
    outcome: "finished" | "errored" | "closed",
  ): void {
    const tracker = this.runTrackers.get(runId);
    if (!tracker || !tracker.pending.has(agentId)) {
      return;
    }
    tracker.pending.delete(agentId);
    tracker.unsubscribes.get(agentId)?.();
    tracker.unsubscribes.delete(agentId);

    if ((outcome === "errored" || outcome === "closed") && !tracker.failedReason) {
      tracker.failedReason = `Agent ${agentId} ${outcome === "errored" ? "failed" : "closed unexpectedly"}`;
      // First error halts the step immediately — siblings keep running, they
      // are not killed.
      void this.finishRun(tracker, "failed", tracker.failedReason);
    }

    if (tracker.pending.size === 0) {
      if (tracker.failedReason) {
        this.clearTracker(runId);
        return;
      }
      void this.finishRun(tracker, "succeeded", null);
    }
  }

  private async finishRun(
    tracker: RunTracker,
    status: "succeeded" | "failed",
    error: string | null,
  ): Promise<void> {
    // Persist-once guard: the tracker is only removed here, after the run is
    // durably marked terminal, so a concurrent settle can't double-write.
    if (!this.runTrackers.has(tracker.runId)) {
      return;
    }

    // Every agent stopping is the earliest a step could be done, not proof that
    // it is. The step's own evidence decides, and a step that names none keeps
    // the old meaning.
    let settledStatus = status;
    let settledError = error;
    if (status === "succeeded") {
      const evidence = await this.collectEvidence(tracker).catch((evidenceError) => ({
        ok: false,
        error: `Could not check this step's evidence: ${
          evidenceError instanceof Error ? evidenceError.message : String(evidenceError)
        }`,
      }));
      if (!evidence.ok) {
        settledStatus = "failed";
        settledError = evidence.error;
      }
    }

    const now = this.now().toISOString();
    let steps: Step[] = [];
    let stepIndex = -1;
    try {
      const result = await this.taskService.mutateStep({
        ...tracker.identifier,
        mutate: (current) => {
          if (current.runs.find((run) => run.id === tracker.runId)?.status !== "running") {
            return current;
          }
          return {
            ...current,
            runs: current.runs.map((run) =>
              run.id === tracker.runId
                ? { ...run, status: settledStatus, endedAt: now, error: settledError }
                : run,
            ),
          };
        },
      });
      steps = result.steps;
      stepIndex = result.stepIndex;
    } finally {
      this.clearTracker(tracker.runId);
    }

    void this.drainQueue().catch((drainError) => {
      this.logger.error({ err: drainError }, "Failed to drain the step-run queue");
    });

    if (settledStatus !== "succeeded" || stepIndex === -1) {
      return;
    }
    await this.afterStepSettled(tracker.identifier.taskId, steps, stepIndex).catch(
      (advanceError) => {
        this.logger.error(
          {
            err: advanceError,
            taskId: tracker.identifier.taskId,
            stepId: tracker.identifier.stepId,
          },
          "Failed to advance the workflow after a step succeeded",
        );
      },
    );
  }

  /**
   * Runs the step's own checks in the workspace its agents used. A run with no
   * workspace (a skip, a schedule placeholder) has nothing to inspect and is
   * taken at its word.
   */
  private async collectEvidence(tracker: RunTracker): Promise<StepEvidenceResult> {
    const workflow = await this.taskService.getWorkflow(tracker.identifier.taskId);
    const step = workflow?.steps.find((entry) => entry.id === tracker.identifier.stepId);
    if (!step) {
      return { ok: true, error: null };
    }
    const requireChanges = step.requireChanges === true;
    const verify = step.verify ?? null;
    if (!requireChanges && !verify) {
      return { ok: true, error: null };
    }
    const run = step.runs.find((entry) => entry.id === tracker.runId);
    const workspaceId = run?.workspaceIds[0];
    const workspace = workspaceId ? await this.getWorkspace(workspaceId) : null;
    if (!workspace) {
      return {
        ok: false,
        error: "This step asks for evidence but its run recorded no workspace to check",
      };
    }
    return checkStepEvidence({
      cwd: workspace.cwd,
      requireChanges,
      verify,
      startCommit: run?.startCommit ?? null,
    });
  }

  /**
   * Drops a run's tracker and everything it holds open.
   *
   * The unsubscribes are not optional cleanup. The first failing agent settles
   * the whole run while its siblings are still working — they are not killed —
   * so by the time they reach a terminal lifecycle the tracker is already gone
   * and their handlers return early, leaving their subscriptions attached to
   * the agent manager for the life of the process.
   */
  private clearTracker(runId: string): void {
    const tracker = this.runTrackers.get(runId);
    if (!tracker) {
      return;
    }
    if (tracker.timeout) {
      clearTimeout(tracker.timeout);
    }
    for (const unsubscribe of tracker.unsubscribes.values()) {
      unsubscribe();
    }
    tracker.unsubscribes.clear();
    this.runTrackers.delete(runId);
  }

  private async afterStepSettled(taskId: string, steps: Step[], stepIndex: number): Promise<void> {
    if (stepIndex < steps.length - 1) {
      const nextIndex = stepIndex + 1;
      await this.advanceStep(taskId, steps, nextIndex).catch((error) => {
        this.logger.error(
          { err: error, taskId, stepId: steps[nextIndex]?.id },
          "Failed to auto-advance to the next step",
        );
      });
      return;
    }
    this.onWorkflowSettled?.(taskId);
  }

  /**
   * Runs once the last step settles, and only when the board asked for it:
   * tearing down a worktree is not something a board should do to you unasked.
   */
  private async archiveWorkspacesIfConfigured(
    taskId: string,
    workspaceIds: Set<string>,
  ): Promise<void> {
    try {
      const task = await this.taskService.getTask(taskId);
      if (!task || !(await this.resolveEffectivePolicy(task)).archiveWorkspacesOnDone) {
        return;
      }
      await this.archivePaseoOwnedWorktrees(workspaceIds);
    } catch (error) {
      this.logger.error({ err: error, taskId }, "Archiving workflow worktrees on done failed");
    }
  }

  private async archivePaseoOwnedWorktrees(workspaceIds: Set<string>): Promise<void> {
    for (const workspaceId of workspaceIds) {
      try {
        const workspace = await this.getWorkspace(workspaceId);
        if (workspace && !workspace.archivedAt && workspace.isPaseoOwnedWorktree) {
          await this.archiveWorkspace(workspaceId);
        }
      } catch (error) {
        this.logger.warn({ err: error, workspaceId }, "Failed to archive a workflow workspace");
      }
    }
  }
}
