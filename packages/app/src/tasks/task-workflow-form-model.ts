import type { AgentProvider } from "@getpaseo/protocol/agent-types";
import type {
  Step,
  StepInput,
  StepTrigger,
  StepWorkspaceStrategy,
} from "@getpaseo/protocol/tasks/workflow";
import { resolveProviderLabel } from "@/tasks/use-task-available-providers";

export interface TaskWorkflowFormDisplay {
  label: string;
}

export interface TaskWorkflowFormProviderOption {
  provider: AgentProvider;
  available: boolean;
}

export interface TaskWorkflowFormSnapshot {
  serverId: string;
  taskId: string;
  /** The workflow already on the task. Editing has to start from what is there
   * rather than from an empty step, or saving would silently replace it. */
  existingSteps?: readonly Step[];
  availableProviders?: readonly TaskWorkflowFormProviderOption[];
}

export type TaskWorkflowFormProviderResolutionStatus = "pending" | "complete";

export interface TaskWorkflowFormProviderChoice {
  id: string;
  value: AgentProvider;
  label: string;
  testID: string;
}

export type TaskWorkflowFormWorkspaceMode = StepWorkspaceStrategy["mode"];
export type TaskWorkflowFormTriggerType = StepTrigger["type"];

/** Workspace strategies a step can be created with here. `existing` is left out:
 * it needs a workspace picker, and a workflow authored on a task card has no
 * workspace in hand yet — the CLI still offers it. */
export const TASK_WORKFLOW_WORKSPACE_MODES: readonly TaskWorkflowFormWorkspaceMode[] = [
  "worktree",
  "worktree_per_agent",
  "reuse_previous",
];

/** `schedule` needs a cadence editor, so the form offers the two triggers that
 * need no further input. */
export const TASK_WORKFLOW_TRIGGER_TYPES: readonly TaskWorkflowFormTriggerType[] = [
  "manual",
  "immediate",
];

export const TASK_WORKFLOW_WORKSPACE_LABEL_KEYS: Record<TaskWorkflowFormWorkspaceMode, string> = {
  worktree: "tasks.workflow.workspace.worktree",
  worktree_per_agent: "tasks.workflow.workspace.worktreePerAgent",
  reuse_previous: "tasks.workflow.workspace.reusePrevious",
  existing: "tasks.workflow.workspace.existing",
};

export const TASK_WORKFLOW_TRIGGER_LABEL_KEYS: Record<TaskWorkflowFormTriggerType, string> = {
  manual: "tasks.workflow.trigger.manual",
  immediate: "tasks.workflow.trigger.immediate",
  schedule: "tasks.workflow.trigger.schedule",
};

export interface TaskWorkflowFormStep {
  /** Refuse to call the step done when its workspace is untouched. */
  requireChanges: boolean;
  /** Stable across edits and reorders so list keys and test ids don't shift. */
  key: string;
  name: string;
  prompt: string;
  provider: AgentProvider | null;
  /** Null means the provider's default model. */
  model: string | null;
  workspaceMode: TaskWorkflowFormWorkspaceMode;
  trigger: TaskWorkflowFormTriggerType;
}

export interface TaskWorkflowFormState {
  serverId: string;
  taskId: string;
  steps: TaskWorkflowFormStep[];
  providerOptions: TaskWorkflowFormProviderChoice[];
  providerResolutionStatus: TaskWorkflowFormProviderResolutionStatus;
  canSubmit: boolean;
  submitError: string | null;
}

export interface TaskWorkflowFormModel {
  getState: () => TaskWorkflowFormState;
  subscribe: (listener: () => void) => () => void;
  close: () => void;
  applyProviderSnapshot: (
    serverId: string,
    providers: readonly TaskWorkflowFormProviderOption[],
  ) => void;
  addStep: () => void;
  removeStep: (key: string) => void;
  moveStep: (key: string, direction: -1 | 1) => void;
  setStepName: (key: string, value: string) => void;
  setStepPrompt: (key: string, value: string) => void;
  setStepAgent: (key: string, agent: { provider: AgentProvider; model: string | null }) => void;
  setStepWorkspaceMode: (key: string, mode: TaskWorkflowFormWorkspaceMode) => void;
  setStepTrigger: (key: string, trigger: TaskWorkflowFormTriggerType) => void;
  setSubmitError: (value: string | null) => void;
}

function buildProviderOptionTestId(provider: AgentProvider): string {
  return `task-workflow-form-provider-option-${provider}`;
}

function buildProviderChoices(
  providers: readonly TaskWorkflowFormProviderOption[],
): TaskWorkflowFormProviderChoice[] {
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
  choices: readonly TaskWorkflowFormProviderChoice[],
  provider: AgentProvider | null,
): TaskWorkflowFormDisplay | null {
  if (!provider) {
    return null;
  }
  const choice = choices.find((entry) => entry.value === provider);
  return { label: choice?.label ?? resolveProviderLabel(provider) };
}

function isStepComplete(step: TaskWorkflowFormStep): boolean {
  return step.name.trim().length > 0 && step.prompt.trim().length > 0 && step.provider !== null;
}

function resolveCanSubmit(state: TaskWorkflowFormState): boolean {
  return state.steps.length > 0 && state.steps.every(isStepComplete);
}

function createStep(input: {
  key: string;
  name: string;
  provider: AgentProvider | null;
}): TaskWorkflowFormStep {
  return {
    key: input.key,
    name: input.name,
    prompt: "",
    provider: input.provider,
    model: null,
    workspaceMode: "worktree",
    // On by default: a step whose agent stopped without touching the checkout
    // has not done the thing, and treating that as success is how a board ends
    // up full of work nobody did.
    requireChanges: true,
    // A step the author just added should not start the moment the workflow exists.
    trigger: "manual",
  };
}

/** A stored step read back into the form. Anything the form cannot express —
 * an `existing` workspace, a scheduled trigger — falls back to what it can, so
 * editing never silently drops a setting it did not show. */
function toFormStep(input: {
  key: string;
  step: Step;
  fallbackProvider: AgentProvider | null;
}): TaskWorkflowFormStep {
  const spec = input.step.agents[0];
  const workspaceMode = TASK_WORKFLOW_WORKSPACE_MODES.includes(input.step.workspace.mode)
    ? input.step.workspace.mode
    : "worktree";
  const trigger = TASK_WORKFLOW_TRIGGER_TYPES.includes(input.step.trigger.type)
    ? input.step.trigger.type
    : "manual";
  return {
    key: input.key,
    name: input.step.name,
    prompt: input.step.prompt,
    provider: spec?.provider ?? input.fallbackProvider,
    model: spec?.model ?? null,
    requireChanges: input.step.requireChanges === true,
    workspaceMode,
    trigger,
  };
}

export function openTaskWorkflowForm(snapshot: TaskWorkflowFormSnapshot): TaskWorkflowFormModel {
  const listeners = new Set<() => void>();
  let closed = false;
  let nextStepKey = 1;
  const initialProviderOptions = buildProviderChoices(snapshot.availableProviders ?? []);
  const initialProvider = initialProviderOptions[0]?.value ?? null;

  const existing = snapshot.existingSteps ?? [];
  let state: TaskWorkflowFormState = {
    serverId: snapshot.serverId,
    taskId: snapshot.taskId,
    steps:
      existing.length > 0
        ? existing.map((step) =>
            toFormStep({ key: `step-${nextStepKey++}`, step, fallbackProvider: initialProvider }),
          )
        : [createStep({ key: `step-${nextStepKey++}`, name: "", provider: initialProvider })],
    providerOptions: initialProviderOptions,
    providerResolutionStatus: snapshot.availableProviders ? "complete" : "pending",
    canSubmit: false,
    submitError: null,
  };
  state = { ...state, canSubmit: resolveCanSubmit(state) };

  function publish(nextState: TaskWorkflowFormState): void {
    if (closed) {
      return;
    }
    state = { ...nextState, canSubmit: resolveCanSubmit(nextState) };
    for (const listener of listeners) {
      listener();
    }
  }

  function updateStep(
    key: string,
    update: (step: TaskWorkflowFormStep) => TaskWorkflowFormStep,
  ): void {
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

export function buildTaskWorkflowSteps(state: TaskWorkflowFormState): StepInput[] | null {
  if (!resolveCanSubmit(state)) {
    return null;
  }
  const steps: StepInput[] = [];
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
      requireChanges: step.requireChanges,
    });
  }
  return steps;
}
