import type { AgentProvider } from "@getpaseo/protocol/agent-types";
import type { KanbanPlanCreateBody } from "@getpaseo/protocol/kanban/rpc-schemas";

type KanbanPlanCreateStep = Extract<KanbanPlanCreateBody, { type: "workflow" }>["steps"][number];
import type { StepTrigger, StepWorkspaceStrategy } from "@getpaseo/protocol/kanban/types";
import { resolveProviderLabel } from "./step-detail";

export interface KanbanPlanFormDisplay {
  label: string;
}

export interface KanbanPlanFormProviderOption {
  provider: AgentProvider;
  available: boolean;
}

export interface KanbanPlanFormSnapshot {
  serverId: string;
  kanbanId: string;
  parentPlanId: string | null;
  availableProviders?: readonly KanbanPlanFormProviderOption[];
}

export type KanbanPlanFormProviderResolutionStatus = "pending" | "complete";

export interface KanbanPlanFormProviderChoice {
  id: string;
  value: AgentProvider;
  label: string;
  testID: string;
}

export type KanbanPlanFormWorkspaceMode = StepWorkspaceStrategy["mode"];
export type KanbanPlanFormTriggerType = StepTrigger["type"];

/** Workspace strategies a step can be created with here. `existing` is left out:
 * it needs a workspace picker, and a plan authored on the board has no workspace
 * in hand yet — the CLI still offers it. */
export const KANBAN_PLAN_WORKSPACE_MODES: readonly KanbanPlanFormWorkspaceMode[] = [
  "worktree",
  "worktree_per_agent",
  "reuse_previous",
];

/** `schedule` needs a cadence editor, so the form offers the two triggers that
 * need no further input. */
export const KANBAN_PLAN_TRIGGER_TYPES: readonly KanbanPlanFormTriggerType[] = [
  "manual",
  "immediate",
];

export interface KanbanPlanFormStep {
  /** Stable across edits and reorders so list keys and test ids don't shift. */
  key: string;
  name: string;
  prompt: string;
  provider: AgentProvider | null;
  /** Null means the provider's default model. */
  model: string | null;
  workspaceMode: KanbanPlanFormWorkspaceMode;
  trigger: KanbanPlanFormTriggerType;
}

export interface KanbanPlanFormState {
  serverId: string;
  kanbanId: string;
  parentPlanId: string | null;
  title: string;
  description: string;
  steps: KanbanPlanFormStep[];
  providerOptions: KanbanPlanFormProviderChoice[];
  providerResolutionStatus: KanbanPlanFormProviderResolutionStatus;
  canSubmit: boolean;
  submitError: string | null;
}

export interface KanbanPlanFormModel {
  getState: () => KanbanPlanFormState;
  subscribe: (listener: () => void) => () => void;
  close: () => void;
  applyProviderSnapshot: (
    serverId: string,
    providers: readonly KanbanPlanFormProviderOption[],
  ) => void;
  setTitle: (value: string) => void;
  setDescription: (value: string) => void;
  addStep: () => void;
  removeStep: (key: string) => void;
  moveStep: (key: string, direction: -1 | 1) => void;
  setStepName: (key: string, value: string) => void;
  setStepPrompt: (key: string, value: string) => void;
  setStepAgent: (key: string, agent: { provider: AgentProvider; model: string | null }) => void;
  setStepWorkspaceMode: (key: string, mode: KanbanPlanFormWorkspaceMode) => void;
  setStepTrigger: (key: string, trigger: KanbanPlanFormTriggerType) => void;
  setSubmitError: (value: string | null) => void;
}

function buildProviderOptionTestId(provider: AgentProvider): string {
  return `kanban-plan-form-provider-option-${provider}`;
}

function buildProviderChoices(
  providers: readonly KanbanPlanFormProviderOption[],
): KanbanPlanFormProviderChoice[] {
  return providers
    .filter((entry) => entry.available)
    .map((entry) => ({
      id: entry.provider,
      value: entry.provider,
      label: resolveProviderLabel(entry.provider),
      testID: buildProviderOptionTestId(entry.provider),
    }));
}

export function resolveProviderDisplay(
  choices: readonly KanbanPlanFormProviderChoice[],
  provider: AgentProvider | null,
): KanbanPlanFormDisplay | null {
  if (!provider) {
    return null;
  }
  const choice = choices.find((entry) => entry.value === provider);
  return { label: choice?.label ?? resolveProviderLabel(provider) };
}

function isStepComplete(step: KanbanPlanFormStep): boolean {
  return step.name.trim().length > 0 && step.prompt.trim().length > 0 && step.provider !== null;
}

function resolveCanSubmit(state: KanbanPlanFormState): boolean {
  return (
    state.title.trim().length > 0 && state.steps.length > 0 && state.steps.every(isStepComplete)
  );
}

function createStep(input: {
  key: string;
  name: string;
  provider: AgentProvider | null;
}): KanbanPlanFormStep {
  return {
    key: input.key,
    name: input.name,
    prompt: "",
    provider: input.provider,
    model: null,
    workspaceMode: "worktree",
    // A step the author just added should not start the moment the plan exists.
    trigger: "manual",
  };
}

export function openKanbanPlanForm(snapshot: KanbanPlanFormSnapshot): KanbanPlanFormModel {
  const listeners = new Set<() => void>();
  let closed = false;
  let nextStepKey = 1;
  const initialProviderOptions = buildProviderChoices(snapshot.availableProviders ?? []);
  const initialProvider = initialProviderOptions[0]?.value ?? null;

  let state: KanbanPlanFormState = {
    serverId: snapshot.serverId,
    kanbanId: snapshot.kanbanId,
    parentPlanId: snapshot.parentPlanId,
    title: "",
    description: "",
    steps: [createStep({ key: `step-${nextStepKey++}`, name: "", provider: initialProvider })],
    providerOptions: initialProviderOptions,
    providerResolutionStatus: snapshot.availableProviders ? "complete" : "pending",
    canSubmit: false,
    submitError: null,
  };
  state = { ...state, canSubmit: resolveCanSubmit(state) };

  function publish(nextState: KanbanPlanFormState): void {
    if (closed) {
      return;
    }
    state = { ...nextState, canSubmit: resolveCanSubmit(nextState) };
    for (const listener of listeners) {
      listener();
    }
  }

  function updateStep(key: string, update: (step: KanbanPlanFormStep) => KanbanPlanFormStep): void {
    publish({
      ...state,
      steps: state.steps.map((step) => (step.key === key ? update(step) : step)),
    });
  }

  return {
    getState: () => state,
    subscribe(listener) {
      if (closed) {
        return () => {};
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close() {
      closed = true;
      listeners.clear();
    },
    applyProviderSnapshot(serverId, providers) {
      if (closed || state.serverId !== serverId) {
        return;
      }
      const providerOptions = buildProviderChoices(providers);
      const fallback = providerOptions[0]?.value ?? null;
      publish({
        ...state,
        providerOptions,
        // A step whose provider vanished from the snapshot falls back rather than
        // silently keeping a provider the host can no longer run.
        steps: state.steps.map((step) => {
          const keeps = providerOptions.some((choice) => choice.value === step.provider);
          return keeps ? step : { ...step, provider: fallback, model: null };
        }),
        providerResolutionStatus: "complete",
      });
    },
    setTitle(value) {
      publish({ ...state, title: value });
    },
    setDescription(value) {
      publish({ ...state, description: value });
    },
    addStep() {
      if (closed) {
        return;
      }
      const previous = state.steps.at(-1);
      publish({
        ...state,
        steps: [
          ...state.steps,
          createStep({
            key: `step-${nextStepKey++}`,
            name: "",
            // Inherit the previous step's agent: a workflow usually runs the same
            // one throughout, and the author can still change it.
            provider: previous?.provider ?? state.providerOptions[0]?.value ?? null,
          }),
        ],
      });
    },
    removeStep(key) {
      if (closed || state.steps.length <= 1) {
        // A workflow with no steps cannot run; the last one stays.
        return;
      }
      publish({ ...state, steps: state.steps.filter((step) => step.key !== key) });
    },
    moveStep(key, direction) {
      if (closed) {
        return;
      }
      const index = state.steps.findIndex((step) => step.key === key);
      const target = index + direction;
      if (index === -1 || target < 0 || target >= state.steps.length) {
        return;
      }
      const steps = [...state.steps];
      const [moved] = steps.splice(index, 1);
      if (!moved) {
        return;
      }
      steps.splice(target, 0, moved);
      publish({ ...state, steps });
    },
    setStepName(key, value) {
      updateStep(key, (step) => ({ ...step, name: value }));
    },
    setStepPrompt(key, value) {
      updateStep(key, (step) => ({ ...step, prompt: value }));
    },
    setStepAgent(key, agent) {
      updateStep(key, (step) => ({ ...step, provider: agent.provider, model: agent.model }));
    },
    setStepWorkspaceMode(key, mode) {
      updateStep(key, (step) => ({ ...step, workspaceMode: mode }));
    },
    setStepTrigger(key, trigger) {
      updateStep(key, (step) => ({ ...step, trigger }));
    },
    setSubmitError(value) {
      publish({ ...state, submitError: value });
    },
  };
}

export function buildKanbanPlanCreateBody(state: KanbanPlanFormState): KanbanPlanCreateBody | null {
  if (!resolveCanSubmit(state)) {
    return null;
  }
  const steps: KanbanPlanCreateStep[] = [];
  for (const step of state.steps) {
    const provider = step.provider;
    if (!provider) {
      return null;
    }
    steps.push({
      name: step.name.trim(),
      prompt: step.prompt.trim(),
      agents: [{ provider, ...(step.model ? { model: step.model } : {}) }],
      completion: "all",
      workspace: { mode: step.workspaceMode } as StepWorkspaceStrategy,
      trigger: { type: step.trigger } as StepTrigger,
    });
  }
  return { type: "workflow", steps };
}
