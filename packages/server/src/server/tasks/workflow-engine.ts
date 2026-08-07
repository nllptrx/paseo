import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import type {
  Step,
  StepAgentSpec,
  StepRun,
  StepRunStatus,
} from "@getpaseo/protocol/tasks/workflow";
import { observeAgentCompletion } from "../agent/agent-completion.js";
import type { AgentManager, ManagedAgent } from "../agent/agent-manager.js";
import { formatProviderModel, type BoundCreateAgentCommand } from "../agent/create-agent/create.js";
import { cancelAgentRunCommand } from "../agent/lifecycle-command.js";
import type { ScheduleService } from "../schedule/service.js";
import type { PersistedWorkspaceRecord } from "../workspace-registry.js";
import type { CreatePaseoWorktreeWorkflowResult } from "../worktree-session.js";
import type { TaskService } from "./service.js";

const RETRYABLE_RUN_STATUSES: ReadonlySet<StepRunStatus> = new Set([
  "failed",
  "interrupted",
  "canceled",
]);

/** A step is addressed by the task that owns the workflow. There is no plan and
 * no nesting, so this is the whole address. */
export interface TaskStepIdentifier {
  taskId: string;
  stepId: string;
}

interface WorktreeWorkspaceInput {
  cwd: string;
  firstAgentContext: { prompt: string };
  /** Where the new branch starts. A subtask starts from its parent's branch so
   * the two stack instead of racing main. */
  baseBranch?: string;
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
    | "getPreset"
    | "isAvailable"
  >;
  agentManager: AgentManager;
  createAgent: BoundCreateAgentCommand;
  scheduleService: Pick<ScheduleService, "createOrReplace" | "delete">;
  getWorkspace: (workspaceId: string) => Promise<PersistedWorkspaceRecord | null>;
  getProjectRootCwd: (paseoProjectId: string) => Promise<string>;
  createWorktreeWorkspace: (
    input: WorktreeWorkspaceInput,
  ) => Promise<CreatePaseoWorktreeWorkflowResult>;
  archiveWorkspace: (workspaceId: string) => Promise<void>;
  logger: Logger;
  now?: () => Date;
  maxConcurrentRuns?: number;
}

interface AgentTarget {
  cwd: string;
  workspaceId: string;
}

// Tracks the agents still in flight for one running StepRun so fan-out
// completion ("all agents settled") can be detected without polling. One
// tracker per run, discarded once the run reaches a terminal status.
interface RunTracker {
  identifier: TaskStepIdentifier;
  runId: string;
  pending: Set<string>;
  failedReason: string | null;
  unsubscribes: Map<string, () => void>;
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

function stepAgentTitle(step: Step, spec: StepAgentSpec, agentIndex: number): string {
  const suffix = spec.model ? `${spec.provider}/${spec.model}` : spec.provider;
  return step.agents.length > 1
    ? `${step.name} (${agentIndex + 1}/${step.agents.length}) — ${suffix}`
    : step.name;
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
  private readonly archiveWorkspace: (workspaceId: string) => Promise<void>;
  private readonly logger: Logger;
  private readonly now: () => Date;
  private readonly runTrackers = new Map<string, RunTracker>();
  private readonly maxConcurrentRuns: number;
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
    this.archiveWorkspace = deps.archiveWorkspace;
    this.logger = deps.logger.child({ module: "task-workflow-engine" });
    this.now = deps.now ?? (() => new Date());
    this.maxConcurrentRuns = deps.maxConcurrentRuns ?? DEFAULT_MAX_CONCURRENT_RUNS;
  }

  /** Fired when a task's last step settles green. The engine only reports; where
   * the task moves is the tracker's decision. */
  setOnWorkflowSettled(listener: (taskId: string) => void): void {
    this.onWorkflowSettled = listener;
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

  async retryStep(identifier: TaskStepIdentifier): Promise<Step> {
    const steps = await this.requireSteps(identifier.taskId);
    const stepIndex = requireStepIndex(steps, identifier.stepId);
    this.assertGateOpen(steps, stepIndex);
    const step = steps[stepIndex];
    const latest = latestRunOf(step);
    if (!latest || !RETRYABLE_RUN_STATUSES.has(latest.status)) {
      throw new Error(`Step ${step.id} has no failed, canceled, or interrupted run to retry`);
    }
    return this.dispatchRun(identifier, steps, stepIndex, latest.workspaceIds);
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
    if (!latest || latest.status !== "running") {
      throw new Error(`Step ${identifier.stepId} has no run in progress to cancel`);
    }
    // Unsubscribe before issuing the cancel: cancelling an agent drives its
    // lifecycle through "idle" the same way finishing does, which would
    // otherwise race the completion observer into reporting a spurious
    // "finished" and writing over this cancellation.
    this.discardTracker(latest.id);
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
    // Known gap: a scheduled step only dispatches agents[0] — multi-agent
    // fan-out under trigger:schedule is not implemented (ScheduleTarget's
    // new-agent config carries exactly one agent).
    const primarySpec = step.agents[0];
    const target = await this.resolveTargetsForStep(identifier, steps, stepIndex, 1);
    const runId = randomUUID();
    const schedule = await this.scheduleService.createOrReplace({
      name: `task-step-${step.id}`,
      prompt: primarySpec.promptOverride ?? step.prompt,
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
    // The schedule fires on its own cadence; backfilling the run with the agent
    // it created, and settling the step from the schedule's own run history,
    // is not implemented.
  }

  private async resolveProjectRootCwd(taskId: string): Promise<string> {
    const task = await this.taskService.getTask(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }
    const project = await this.taskService.getProject(task.projectId);
    if (!project?.paseoProjectId) {
      throw new Error(
        `Task ${taskId} cannot create a worktree: its board is not linked to a Paseo project`,
      );
    }
    return this.getProjectRootCwd(project.paseoProjectId);
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
  async delegate(input: { taskId: string; presetId: string }): Promise<{ agentId: string }> {
    const preset = await this.taskService.getPreset(input.presetId);
    if (!preset) {
      throw new Error(`Preset not found: ${input.presetId}`);
    }
    const task = await this.taskService.getTask(input.taskId);
    if (!task) {
      throw new Error(`Task not found: ${input.taskId}`);
    }

    const target = await this.resolveDelegateTarget(input.taskId, preset, task.title);
    const prompt =
      preset.instructions.trim().length > 0
        ? `${preset.instructions.trim()}\n\n${task.title}`
        : task.title;

    const created = await this.createAgent({
      kind: "mcp",
      provider: formatProviderModel(
        preset.provider as StepAgentSpec["provider"],
        preset.model ?? undefined,
      ),
      title: task.title,
      initialPrompt: prompt,
      cwd: target.cwd,
      workspaceId: target.workspaceId,
      mode: preset.modeId ?? undefined,
      thinking: preset.thinkingOptionId ?? undefined,
      unattended: false,
      promptFailure: "return-error",
      background: true,
      notifyOnFinish: false,
    });

    await this.taskService.attachAgent({
      taskId: input.taskId,
      agentId: created.snapshot.id,
      workspaceId: target.workspaceId,
      presetId: preset.id,
    });
    return { agentId: created.snapshot.id };
  }

  /**
   * Where a delegated agent runs. `project_default` means "where this card is
   * already being worked" — the workspace an agent on it is using. A card with
   * nobody on it yet has no such place, so it gets a worktree like the other
   * mode: an agent has to run somewhere, and the project root is not a
   * workspace this daemon can attach to.
   */
  private async resolveDelegateTarget(
    taskId: string,
    preset: { environmentKind: "project_default" | "new_worktree"; baseBranch: string | null },
    prompt: string,
  ): Promise<AgentTarget> {
    if (preset.environmentKind === "project_default") {
      const existing = await this.resolveExistingTaskWorkspace(taskId);
      if (existing) {
        return existing;
      }
    }
    const sourceCwd = await this.resolveProjectRootCwd(taskId);
    const baseBranch = preset.baseBranch ?? (await this.resolveParentBranch(taskId));
    const created = await this.createWorktreeWorkspace({
      cwd: sourceCwd,
      firstAgentContext: { prompt },
      ...(baseBranch ? { baseBranch } : {}),
    });
    return { cwd: created.workspace.cwd, workspaceId: created.workspace.workspaceId };
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

  private async resolveParentBranch(taskId: string): Promise<string | null> {
    const task = await this.taskService.getTask(taskId);
    if (!task?.parentTaskId) {
      return null;
    }
    const parentLinks = await this.taskService.listTaskAgents(task.parentTaskId);
    for (const link of parentLinks) {
      const workspace = await this.getWorkspace(link.workspaceId);
      if (workspace && !workspace.archivedAt && workspace.branch) {
        return workspace.branch;
      }
    }
    return null;
  }

  private async resolveTargetsForStep(
    identifier: TaskStepIdentifier,
    steps: Step[],
    stepIndex: number,
    agentCount: number,
  ): Promise<AgentTarget[]> {
    const step = steps[stepIndex];
    switch (step.workspace.mode) {
      case "existing": {
        const workspace = await this.getWorkspace(step.workspace.workspaceId);
        if (!workspace || workspace.archivedAt) {
          throw new Error(`Workspace not found: ${step.workspace.workspaceId}`);
        }
        return Array.from({ length: agentCount }, () => ({
          cwd: workspace.cwd,
          workspaceId: workspace.workspaceId,
        }));
      }
      case "worktree": {
        const sourceCwd = await this.resolveProjectRootCwd(identifier.taskId);
        const baseBranch = await this.resolveParentBranch(identifier.taskId);
        const created = await this.createWorktreeWorkspace({
          cwd: sourceCwd,
          firstAgentContext: { prompt: step.prompt },
          ...(baseBranch ? { baseBranch } : {}),
        });
        return Array.from({ length: agentCount }, () => ({
          cwd: created.workspace.cwd,
          workspaceId: created.workspace.workspaceId,
        }));
      }
      case "worktree_per_agent": {
        const sourceCwd = await this.resolveProjectRootCwd(identifier.taskId);
        const baseBranch = await this.resolveParentBranch(identifier.taskId);
        const targets: AgentTarget[] = [];
        for (let i = 0; i < agentCount; i++) {
          const created = await this.createWorktreeWorkspace({
            cwd: sourceCwd,
            firstAgentContext: { prompt: step.prompt },
            ...(baseBranch ? { baseBranch } : {}),
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

  private hasFreeSlot(): boolean {
    return this.runTrackers.size < this.maxConcurrentRuns;
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

  private async dispatchRun(
    identifier: TaskStepIdentifier,
    steps: Step[],
    stepIndex: number,
    reuseWorkspaceIds: string[] | null,
  ): Promise<Step> {
    if (!this.hasFreeSlot()) {
      return this.enqueueRun(identifier, reuseWorkspaceIds);
    }
    const step = steps[stepIndex];
    const targets = reuseWorkspaceIds
      ? await this.resolveTargetsFromWorkspaceIds(reuseWorkspaceIds, step.agents.length)
      : await this.resolveTargetsForStep(identifier, steps, stepIndex, step.agents.length);

    const runId = randomUUID();
    const labels = stepRunLabels(identifier.taskId, step.id, runId);
    const agentIds: string[] = [];
    let creationError: string | null = null;

    for (let i = 0; i < step.agents.length; i++) {
      const spec = step.agents[i];
      const target = targets.length === 1 ? targets[0] : targets[i];
      try {
        const created = await this.createAgent({
          kind: "mcp",
          provider: formatProviderModel(spec.provider, spec.model),
          title: stepAgentTitle(step, spec, i),
          initialPrompt: spec.promptOverride ?? step.prompt,
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
            error:
              initialStatus === "failed" ? (creationError ?? "No agent could be created") : null,
          },
        ],
      }),
    });

    if (agentIds.length === 0) {
      return updatedStep;
    }

    await this.attachRunAgentsToTask(identifier.taskId, agentIds, targets);
    this.trackRun(identifier, runId, agentIds, creationError);
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
    try {
      for (let i = 0; i < agentIds.length; i++) {
        const target = targets.length === 1 ? targets[0] : targets[i];
        await this.taskService.attachAgent({
          taskId,
          agentId: agentIds[i],
          workspaceId: target.workspaceId,
        });
      }
    } catch (error) {
      this.logger.error({ err: error, taskId }, "Failed to attach step-run agents to the task");
    }
  }

  private trackRun(
    identifier: TaskStepIdentifier,
    runId: string,
    agentIds: string[],
    initialError: string | null,
  ): void {
    const tracker: RunTracker = {
      identifier,
      runId,
      pending: new Set(agentIds),
      failedReason: initialError,
      unsubscribes: new Map(),
    };
    this.runTrackers.set(runId, tracker);

    for (const agentId of agentIds) {
      const observer = observeAgentCompletion();
      const unsubscribe = this.agentManager.subscribe(
        (event) => {
          if (event.type !== "agent_state") {
            return;
          }
          const outcome = observer.observeLifecycle(event.agent.lifecycle);
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
      const initialOutcome = observer.observeLifecycle(snapshot?.lifecycle ?? "closed");
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
        this.runTrackers.delete(runId);
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
              run.id === tracker.runId ? { ...run, status, endedAt: now, error } : run,
            ),
          };
        },
      });
      steps = result.steps;
      stepIndex = result.stepIndex;
    } finally {
      if (status === "succeeded") {
        this.runTrackers.delete(tracker.runId);
      }
    }

    void this.drainQueue().catch((drainError) => {
      this.logger.error({ err: drainError }, "Failed to drain the step-run queue");
    });

    if (status !== "succeeded" || stepIndex === -1) {
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

  private discardTracker(runId: string): void {
    const tracker = this.runTrackers.get(runId);
    if (!tracker) {
      return;
    }
    for (const unsubscribe of tracker.unsubscribes.values()) {
      unsubscribe();
    }
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
    await this.archiveWorkspacesIfConfigured(taskId, steps);
    this.onWorkflowSettled?.(taskId);
  }

  /**
   * Runs once the last step settles, and only when the board asked for it:
   * tearing down a worktree is not something a board should do to you unasked.
   */
  private async archiveWorkspacesIfConfigured(taskId: string, steps: Step[]): Promise<void> {
    try {
      const task = await this.taskService.getTask(taskId);
      const project = task ? await this.taskService.getProject(task.projectId) : null;
      if (!project?.board?.archiveWorkspacesOnDone) {
        return;
      }
      await this.archivePaseoOwnedWorktrees(steps);
    } catch (error) {
      this.logger.error({ err: error, taskId }, "Archiving workflow worktrees on done failed");
    }
  }

  private async archivePaseoOwnedWorktrees(steps: Step[]): Promise<void> {
    const workspaceIds = new Set<string>();
    for (const step of steps) {
      for (const run of step.runs) {
        for (const workspaceId of run.workspaceIds) {
          workspaceIds.add(workspaceId);
        }
      }
    }
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
