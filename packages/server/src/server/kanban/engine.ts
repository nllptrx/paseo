import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import type {
  KanbanPlan,
  NestedPlan,
  Step,
  StepAgentSpec,
  StepRun,
  StepRunStatus,
  StoredKanban,
} from "@getpaseo/protocol/kanban/types";
import type { AgentManager, ManagedAgent } from "../agent/agent-manager.js";
import { observeAgentCompletion } from "../agent/agent-completion.js";
import { formatProviderModel, type BoundCreateAgentCommand } from "../agent/create-agent/create.js";
import { cancelAgentRunCommand } from "../agent/lifecycle-command.js";
import type { ScheduleService } from "../schedule/service.js";
import type { PersistedWorkspaceRecord } from "../workspace-registry.js";
import type { CreatePaseoWorktreeWorkflowResult } from "../worktree-session.js";
import { KanbanService } from "./service.js";

const RETRYABLE_RUN_STATUSES: ReadonlySet<StepRunStatus> = new Set([
  "failed",
  "interrupted",
  "canceled",
]);

export interface StepIdentifier {
  kanbanId: string;
  parentPlanId?: string | null;
  planId: string;
  stepId: string;
}

interface WorktreeWorkspaceInput {
  cwd: string;
  firstAgentContext: { prompt: string };
}

export interface KanbanEngineDeps {
  kanbanService: KanbanService;
  agentManager: AgentManager;
  createAgent: BoundCreateAgentCommand;
  scheduleService: Pick<ScheduleService, "createOrReplace" | "delete">;
  getWorkspace: (workspaceId: string) => Promise<PersistedWorkspaceRecord | null>;
  getProjectRootCwd: (projectId: string) => Promise<string>;
  createWorktreeWorkspace: (
    input: WorktreeWorkspaceInput,
  ) => Promise<CreatePaseoWorktreeWorkflowResult>;
  archiveWorkspace: (workspaceId: string) => Promise<void>;
  /** Records a dispatched agent on the plan's task, when the plan has one. The
   * attachment carries no completion observer — for plan work the run settling
   * is the signal, not each agent's turn. */
  attachTaskAgent?: (input: {
    taskId: string;
    agentId: string;
    workspaceId: string;
  }) => Promise<void>;
  logger: Logger;
  now?: () => Date;
}

interface AgentTarget {
  cwd: string;
  workspaceId: string;
}

// Tracks the agents still in flight for one running StepRun so fan-out
// completion ("all agents settled") can be detected without polling. One
// tracker per run, discarded once the run reaches a terminal status.
interface RunTracker {
  identifier: StepIdentifier;
  runId: string;
  pending: Set<string>;
  failedReason: string | null;
  unsubscribes: Map<string, () => void>;
}

function latestRunOf(step: Step): StepRun | null {
  return step.runs.length > 0 ? step.runs[step.runs.length - 1] : null;
}

function requireWorkflowSteps(plan: KanbanPlan | NestedPlan, planId: string): Step[] {
  if (plan.body.type !== "workflow") {
    throw new Error(`Plan is not a workflow: ${planId}`);
  }
  return plan.body.steps;
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

function stepRunLabels(planId: string, stepId: string, runId: string): Record<string, string> {
  return {
    "paseo.plan-id": planId,
    "paseo.step-id": stepId,
    "paseo.step-run-id": runId,
  };
}

/**
 * Runs the kanban workflow engine: hard gates between steps, multi-agent
 * fan-out dispatch, and timed-step schedule materialization.
 *
 * There is no card-move path. Columns are derived from what these runs record,
 * so finishing a step is the whole story — nothing has to be pushed back to a
 * board afterwards to keep it true.
 */
export class KanbanEngine {
  private readonly kanbanService: KanbanService;
  private readonly agentManager: AgentManager;
  private readonly createAgent: BoundCreateAgentCommand;
  private readonly scheduleService: Pick<ScheduleService, "createOrReplace" | "delete">;
  private readonly getWorkspace: (workspaceId: string) => Promise<PersistedWorkspaceRecord | null>;
  private readonly getProjectRootCwd: (projectId: string) => Promise<string>;
  private readonly createWorktreeWorkspace: (
    input: WorktreeWorkspaceInput,
  ) => Promise<CreatePaseoWorktreeWorkflowResult>;
  private readonly archiveWorkspace: (workspaceId: string) => Promise<void>;
  private readonly logger: Logger;
  private readonly now: () => Date;
  private readonly attachTaskAgent:
    | ((input: { taskId: string; agentId: string; workspaceId: string }) => Promise<void>)
    | null;
  private readonly runTrackers = new Map<string, RunTracker>();
  private onPlanSettled: ((taskId: string) => void) | null = null;

  constructor(deps: KanbanEngineDeps) {
    this.kanbanService = deps.kanbanService;
    this.agentManager = deps.agentManager;
    this.createAgent = deps.createAgent;
    this.scheduleService = deps.scheduleService;
    this.getWorkspace = deps.getWorkspace;
    this.getProjectRootCwd = deps.getProjectRootCwd;
    this.createWorktreeWorkspace = deps.createWorktreeWorkspace;
    this.archiveWorkspace = deps.archiveWorkspace;
    this.logger = deps.logger.child({ module: "kanban-engine" });
    this.now = deps.now ?? (() => new Date());
    this.attachTaskAgent = deps.attachTaskAgent ?? null;
  }

  // Boot recovery: any step run still "running" when the daemon went down
  // cannot be trusted (its in-memory tracker is gone) — mark it interrupted,
  // same as ScheduleService.recoverInterruptedRuns. No auto-resume: the user
  // retries explicitly.
  async recoverInterruptedRuns(): Promise<void> {
    const kanbans = await this.kanbanService.list();
    await Promise.all(kanbans.map((summary) => this.recoverInterruptedRunsForKanban(summary.id)));
  }

  private async recoverInterruptedRunsForKanban(kanbanId: string): Promise<void> {
    const kanban = await this.kanbanService.get(kanbanId);
    if (!kanban) {
      return;
    }
    const now = this.now().toISOString();
    for (const [planId, plan] of Object.entries(kanban.plans)) {
      if (plan.body.type === "workflow") {
        await this.interruptRunningSteps({ kanbanId, planId, steps: plan.body.steps }, now);
      } else {
        for (const [nestedId, nested] of Object.entries(plan.body.plans)) {
          await this.interruptRunningSteps(
            { kanbanId, parentPlanId: planId, planId: nestedId, steps: nested.body.steps },
            now,
          );
        }
      }
    }
  }

  private async interruptRunningSteps(
    scope: { kanbanId: string; parentPlanId?: string; planId: string; steps: Step[] },
    now: string,
  ): Promise<void> {
    for (const step of scope.steps) {
      const latest = latestRunOf(step);
      if (!latest || latest.status !== "running") {
        continue;
      }
      await this.kanbanService.mutateStep({
        kanbanId: scope.kanbanId,
        parentPlanId: scope.parentPlanId,
        planId: scope.planId,
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

  /**
   * Runs once a plan's last step settles: the only automation left, and it is
   * opt-in per kanban because tearing down a worktree is not something a board
   * should do to you unasked.
   */
  private async archiveWorkspacesIfConfigured(params: {
    kanbanId: string;
    parentPlanId?: string | null;
    planId: string;
  }): Promise<void> {
    const kanban = await this.kanbanService.get(params.kanbanId);
    if (!kanban?.archiveWorkspacesOnDone) {
      return;
    }
    const plan = this.findPlanForAutomations(kanban, params.parentPlanId, params.planId);
    if (!plan || plan.body.type !== "workflow") {
      // Nested-kanban cards have no steps of their own to archive.
      return;
    }
    await this.archivePaseoOwnedWorktrees(plan.body.steps).catch((error) => {
      this.logger.error(
        { err: error, kanbanId: params.kanbanId, planId: params.planId },
        "Archiving plan worktrees on done failed",
      );
    });
  }

  private findPlanForAutomations(
    kanban: StoredKanban,
    parentPlanId: string | null | undefined,
    planId: string,
  ): KanbanPlan | NestedPlan | undefined {
    if (!parentPlanId) {
      return kanban.plans[planId];
    }
    const parent = kanban.plans[parentPlanId];
    return parent?.body.type === "nested_kanban" ? parent.body.plans[planId] : undefined;
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
        this.logger.warn(
          { err: error, workspaceId },
          "Failed to archive workspace on column entry",
        );
      }
    }
  }

  // trigger:immediate or trigger:schedule steps advance themselves once
  // gated open; trigger:manual and explicit run/retry requests go through
  // `runStep`/`retryStep` below, which call this with the same effect.
  private async advanceStep(
    identifier: { kanbanId: string; parentPlanId?: string | null; planId: string },
    steps: Step[],
    stepIndex: number,
  ): Promise<void> {
    const step = steps[stepIndex];
    if (step.trigger.type === "manual") {
      return;
    }
    if (step.trigger.type === "schedule") {
      await this.materializeScheduleForStep({ ...identifier, stepId: step.id }, steps, stepIndex);
      return;
    }
    await this.dispatchRun({ ...identifier, stepId: step.id }, steps, stepIndex, null);
  }

  async runStep(identifier: StepIdentifier): Promise<Step> {
    const { plan } = await this.kanbanService.getPlan(identifier);
    const steps = requireWorkflowSteps(plan, identifier.planId);
    const stepIndex = requireStepIndex(steps, identifier.stepId);
    this.assertGateOpen(steps, stepIndex);
    this.assertNotRunning(steps[stepIndex]);
    return this.dispatchRun(identifier, steps, stepIndex, null);
  }

  async retryStep(identifier: StepIdentifier): Promise<Step> {
    const { plan } = await this.kanbanService.getPlan(identifier);
    const steps = requireWorkflowSteps(plan, identifier.planId);
    const stepIndex = requireStepIndex(steps, identifier.stepId);
    this.assertGateOpen(steps, stepIndex);
    const step = steps[stepIndex];
    const latest = latestRunOf(step);
    if (!latest || !RETRYABLE_RUN_STATUSES.has(latest.status)) {
      throw new Error(`Step ${step.id} has no failed, canceled, or interrupted run to retry`);
    }
    return this.dispatchRun(identifier, steps, stepIndex, latest.workspaceIds);
  }

  async skipStep(identifier: StepIdentifier): Promise<Step> {
    const { plan } = await this.kanbanService.getPlan(identifier);
    const steps = requireWorkflowSteps(plan, identifier.planId);
    const stepIndex = requireStepIndex(steps, identifier.stepId);
    this.assertNotRunning(steps[stepIndex]);
    const now = this.now().toISOString();
    const { step } = await this.kanbanService.mutateStep({
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
    await this.afterStepSettled(identifier, steps, stepIndex);
    return step;
  }

  async cancelStep(identifier: StepIdentifier): Promise<Step> {
    const { plan } = await this.kanbanService.getPlan(identifier);
    const steps = requireWorkflowSteps(plan, identifier.planId);
    const stepIndex = requireStepIndex(steps, identifier.stepId);
    const step = steps[stepIndex];
    const latest = latestRunOf(step);
    if (!latest || latest.status !== "running") {
      throw new Error(`Step ${step.id} has no run in progress to cancel`);
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
    const { step: updated } = await this.kanbanService.mutateStep({
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
    return updated;
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
    if (latest?.status === "running") {
      throw new Error(`Step ${step.id} already has a run in progress`);
    }
  }

  private async materializeScheduleForStep(
    identifier: StepIdentifier,
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
      name: `kanban-step-${step.id}`,
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
          labels: Object.entries(stepRunLabels(identifier.planId, step.id, runId)).map(
            ([key, value]) => `${key}=${value}`,
          ),
        },
      },
    });
    await this.kanbanService.mutateStep({
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
    if (stepIndex === 0) {
    }
    // The schedule fires on its own cadence; run/agent-id backfill and step
    // outcome for schedule-triggered steps land with the orchestrator mesh
    // slice, which needs to observe the schedule's own run history. Tracked
    // as a known gap in this slice's completion.
  }

  private async resolveTargetsForStep(
    identifier: StepIdentifier,
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
        const kanban = await this.kanbanService.get(identifier.kanbanId);
        if (!kanban) {
          throw new Error(`Kanban not found: ${identifier.kanbanId}`);
        }
        const sourceCwd = await this.getProjectRootCwd(kanban.projectId);
        const created = await this.createWorktreeWorkspace({
          cwd: sourceCwd,
          firstAgentContext: { prompt: step.prompt },
        });
        return Array.from({ length: agentCount }, () => ({
          cwd: created.workspace.cwd,
          workspaceId: created.workspace.workspaceId,
        }));
      }
      case "worktree_per_agent": {
        const kanban = await this.kanbanService.get(identifier.kanbanId);
        if (!kanban) {
          throw new Error(`Kanban not found: ${identifier.kanbanId}`);
        }
        const sourceCwd = await this.getProjectRootCwd(kanban.projectId);
        const targets: AgentTarget[] = [];
        for (let i = 0; i < agentCount; i++) {
          const created = await this.createWorktreeWorkspace({
            cwd: sourceCwd,
            firstAgentContext: { prompt: step.prompt },
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

  private async dispatchRun(
    identifier: StepIdentifier,
    steps: Step[],
    stepIndex: number,
    reuseWorkspaceIds: string[] | null,
  ): Promise<Step> {
    const step = steps[stepIndex];
    const targets = reuseWorkspaceIds
      ? await this.resolveTargetsFromWorkspaceIds(reuseWorkspaceIds, step.agents.length)
      : await this.resolveTargetsForStep(identifier, steps, stepIndex, step.agents.length);

    const runId = randomUUID();
    const labels = stepRunLabels(identifier.planId, step.id, runId);
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
          { err: error, planId: identifier.planId, stepId: step.id },
          "Failed to create step-run agent",
        );
      }
    }

    const workspaceIds = Array.from(new Set(targets.map((target) => target.workspaceId)));
    const startedAt = this.now().toISOString();
    const initialStatus: StepRunStatus = agentIds.length === 0 ? "failed" : "running";
    const { step: updatedStep } = await this.kanbanService.mutateStep({
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

    await this.attachRunAgentsToPlanTask(identifier, agentIds, targets);
    this.trackRun(identifier, runId, agentIds, creationError);
    return updatedStep;
  }

  private async attachRunAgentsToPlanTask(
    identifier: StepIdentifier,
    agentIds: string[],
    targets: AgentTarget[],
  ): Promise<void> {
    if (!this.attachTaskAgent) {
      return;
    }
    try {
      const { plan } = await this.kanbanService.getPlan(identifier);
      if (!plan.taskId) {
        return;
      }
      for (let i = 0; i < agentIds.length; i++) {
        const target = targets.length === 1 ? targets[0] : targets[i];
        await this.attachTaskAgent({
          taskId: plan.taskId,
          agentId: agentIds[i],
          workspaceId: target.workspaceId,
        });
      }
    } catch (error) {
      this.logger.error(
        { err: error, planId: identifier.planId },
        "Failed to attach step-run agents to the plan's task",
      );
    }
  }

  private trackRun(
    identifier: StepIdentifier,
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
      const { step } = await this.kanbanService.mutateStep({
        ...tracker.identifier,
        mutate: (current, context) => {
          steps = context.steps;
          stepIndex = context.stepIndex;
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
      void step;
    } finally {
      if (status === "succeeded") {
        this.runTrackers.delete(tracker.runId);
      }
    }

    if (status !== "succeeded" || stepIndex === -1) {
      return;
    }
    await this.afterStepSettled(tracker.identifier, steps, stepIndex).catch((advanceError) => {
      this.logger.error(
        { err: advanceError, planId: tracker.identifier.planId, stepId: tracker.identifier.stepId },
        "Failed to advance workflow after step succeeded",
      );
    });
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

  /** Fired when a plan's last step settles green — the tracker moves the plan's
   * task off it. The engine only reports; the transition rules live with tasks. */
  setOnPlanSettled(listener: (taskId: string) => void): void {
    this.onPlanSettled = listener;
  }

  private async notifyPlanSettled(identifier: {
    kanbanId: string;
    parentPlanId?: string | null;
    planId: string;
  }): Promise<void> {
    if (!this.onPlanSettled) {
      return;
    }
    try {
      const { plan } = await this.kanbanService.getPlan(identifier);
      if (plan.taskId) {
        this.onPlanSettled(plan.taskId);
      }
    } catch (error) {
      this.logger.error(
        { err: error, planId: identifier.planId },
        "Failed to resolve a settled plan's task",
      );
    }
  }

  private async afterStepSettled(
    identifier: { kanbanId: string; parentPlanId?: string | null; planId: string },
    steps: Step[],
    stepIndex: number,
  ): Promise<void> {
    const isLastStep = stepIndex === steps.length - 1;
    if (isLastStep) {
      await this.archiveWorkspacesIfConfigured(identifier);
      await this.notifyPlanSettled(identifier);
      return;
    }
    const nextIndex = stepIndex + 1;
    await this.advanceStep(identifier, steps, nextIndex).catch((error) => {
      this.logger.error(
        { err: error, planId: identifier.planId, stepId: steps[nextIndex]?.id },
        "Failed to auto-advance to next step",
      );
    });
  }
}
