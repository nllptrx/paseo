import type { AgentProvider } from "@getpaseo/protocol/agent-types";
import type {
  Step,
  StepAgentSpec,
  StepRun,
  StepRunStatus,
  StepTrigger,
  StepWorkspaceStrategy,
} from "@getpaseo/protocol/kanban/types";
import { AGENT_PROVIDER_DEFINITIONS } from "@getpaseo/protocol/provider-manifest";

export type StepActionKind = "run" | "retry" | "skip" | "cancel";

export const STEP_WORKSPACE_LABEL_KEYS: Record<StepWorkspaceStrategy["mode"], string> = {
  worktree: "kanban.planForm.workspace.worktree",
  worktree_per_agent: "kanban.planForm.workspace.worktreePerAgent",
  reuse_previous: "kanban.planForm.workspace.reusePrevious",
  existing: "kanban.planForm.workspace.existing",
};

export const STEP_TRIGGER_LABEL_KEYS: Record<StepTrigger["type"], string> = {
  manual: "kanban.planForm.trigger.manual",
  immediate: "kanban.planForm.trigger.immediate",
  schedule: "kanban.planForm.trigger.schedule",
};

/** The last run is the authoritative one; the ones before it are retry history. */
export function resolveStepStatus(step: Step): StepRunStatus | null {
  return step.runs.at(-1)?.status ?? null;
}

/**
 * Whether the previous step has cleared the hard gate. Steps run in order, so a
 * step behind an unfinished one has nothing to offer however it looks itself —
 * the daemon would reject the dispatch.
 */
export function isStepGateOpen(steps: readonly Step[], stepIndex: number): boolean {
  if (stepIndex <= 0) {
    return true;
  }
  const previous = steps[stepIndex - 1];
  if (!previous) {
    return false;
  }
  const status = resolveStepStatus(previous);
  return status === "succeeded" || status === "skipped";
}

/**
 * The actions a step can actually take, which is what a surface should offer.
 * The daemon rejects the rest: run and retry are gated on the previous step,
 * retry needs a run that failed, cancel needs one still going, and a step that
 * has already settled successfully is finished with.
 *
 * Run and retry never both appear. A failed step can technically be run again,
 * but retry is the one that reuses the workspace it failed in, so it is the only
 * one offered.
 */
export function resolveStepActions(steps: readonly Step[], stepIndex: number): StepActionKind[] {
  const step = steps[stepIndex];
  if (!step) {
    return [];
  }
  const status = resolveStepStatus(step);
  if (status === "running") {
    return ["cancel"];
  }
  if (status === "succeeded" || status === "skipped") {
    return [];
  }

  const actions: StepActionKind[] = [];
  const gateOpen = isStepGateOpen(steps, stepIndex);
  if (gateOpen) {
    actions.push(status === null ? "run" : "retry");
  }
  actions.push("skip");
  return actions;
}

/** Newest first: the run you want to read about is the one that just happened. */
export function resolveStepRunHistory(step: Step): StepRun[] {
  return step.runs.toReversed();
}

/**
 * The conversation a step's work happened in. A run still going wins over a
 * finished one, and a run that recorded no agent (a skip) has nothing to open.
 */
export function resolveStepChatTarget(step: Step): { workspaceId: string; agentId: string } | null {
  const running = step.runs.find((run) => run.status === "running");
  const candidates = running ? [running] : resolveStepRunHistory(step);
  for (const run of candidates) {
    const agentId = run.agentIds[0];
    const workspaceId = run.workspaceIds[0];
    if (agentId && workspaceId) {
      return { workspaceId, agentId };
    }
  }
  return null;
}

/** The manifest label for a provider, falling back to its id so a provider this
 * client does not know about still reads as itself. */
export function resolveProviderLabel(provider: AgentProvider): string {
  return (
    AGENT_PROVIDER_DEFINITIONS.find((definition) => definition.id === provider)?.label ?? provider
  );
}

export interface StepAgentDescription {
  /** Position is the only thing that tells two entries of the same provider
   * apart, and a step's agent list is fixed, so it is a stable render key. */
  key: string;
  provider: AgentProvider;
  model: string | null;
}

/** What the step sends: the agent, and the model it runs on when the plan pins
 * one rather than leaving the provider's default. */
export function describeStepAgents(step: Step): StepAgentDescription[] {
  return step.agents.map((agent: StepAgentSpec, index: number) => ({
    key: `${index}:${agent.provider}`,
    provider: agent.provider,
    model: agent.model ?? null,
  }));
}
