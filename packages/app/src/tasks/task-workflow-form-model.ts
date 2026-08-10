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
  cwd?: string | null;
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
  /** A command that has to pass, written as a command line and split on
   * spaces. Empty means the step asks for no command. */
  verifyCommand: string;
  /** Minutes, as typed. Empty means no ceiling. */
  timeoutMinutes: string;
  /** Stable across edits and reorders so list keys and test ids don't shift. */
  key: string;
  name: string;
  prompt: string;
  provider: AgentProvider | null;
  /** Null means the provider's default model. */
  model: string | null;
  modeId: string | null;
  thinkingOptionId: string | null;
  featureValues?: Record<string, unknown>;
  workspaceMode: TaskWorkflowFormWorkspaceMode;
  trigger: TaskWorkflowFormTriggerType;
  /** The stored step this one was read from, kept so saving can put back the
   * agents past the first, an `existing` workspace's id, and a schedule's
   * cadence. Absent on a step the author just added. */
  source?: Step;
}

export interface TaskWorkflowFormState {
  serverId: string;
  taskId: string;
  cwd: string | null;
  /** Whether ordinary steps after the first start as soon as their predecessor
   * succeeds. Stored through each step's existing trigger. */
  autoContinue: boolean;
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
  applyCwd: (serverId: string, cwd: string | null) => void;
  applyProviderSnapshot: (
    serverId: string,
    providers: readonly TaskWorkflowFormProviderOption[],
  ) => void;
  applyExistingSteps: (serverId: string, taskId: string, steps: readonly Step[]) => void;
  addStep: () => void;
  setAutoContinue: (value: boolean) => void;
  removeStep: (key: string) => void;
  moveStep: (key: string, direction: -1 | 1) => void;
  setStepName: (key: string, value: string) => void;
  setStepPrompt: (key: string, value: string) => void;
  setStepAgent: (key: string, agent: { provider: AgentProvider; model: string | null }) => void;
  setStepMode: (key: string, modeId: string | null) => void;
  setStepThinking: (key: string, thinkingOptionId: string | null) => void;
  setStepFeatureValues: (key: string, featureValues: Record<string, unknown> | undefined) => void;
  setStepWorkspaceMode: (key: string, mode: TaskWorkflowFormWorkspaceMode) => void;
  setStepRequireChanges: (key: string, requireChanges: boolean) => void;
  setStepVerifyCommand: (key: string, command: string) => void;
  setStepTimeoutMinutes: (key: string, minutes: string) => void;
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

/** Adds any provider a step already uses to the list, so an unavailable one is
 * still shown as the step's choice instead of reading as unset. */
function withStepProviders(
  choices: TaskWorkflowFormProviderChoice[],
  steps: readonly TaskWorkflowFormStep[],
): TaskWorkflowFormProviderChoice[] {
  const listed = new Set(choices.map((choice) => choice.value));
  const extra: TaskWorkflowFormProviderChoice[] = [];
  for (const step of steps) {
    if (step.provider && !listed.has(step.provider)) {
      listed.add(step.provider);
      extra.push({
        id: step.provider,
        value: step.provider,
        label: resolveProviderLabel(step.provider),
        testID: buildProviderOptionTestId(step.provider),
      });
    }
  }
  return [...choices, ...extra];
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

/**
 * A step's workspace and trigger can name the step before it, which the first
 * step does not have. Reordering can put such a step first, and the daemon
 * refuses to run it — so the choice is corrected here, where the author can see
 * it change, rather than at dispatch.
 */
function withPositionValidChoices(step: TaskWorkflowFormStep, index: number): TaskWorkflowFormStep {
  if (index > 0) {
    return step;
  }
  const workspaceMode = step.workspaceMode === "reuse_previous" ? "worktree" : step.workspaceMode;
  const trigger = step.trigger === "immediate" ? "manual" : step.trigger;
  return workspaceMode === step.workspaceMode && trigger === step.trigger
    ? step
    : { ...step, workspaceMode, trigger };
}

function isStepComplete(step: TaskWorkflowFormStep): boolean {
  return step.name.trim().length > 0 && step.provider !== null;
}

function resolveCanSubmit(state: TaskWorkflowFormState): boolean {
  return state.steps.length > 0 && state.steps.every(isStepComplete);
}

function createStep(input: {
  key: string;
  name: string;
  provider: AgentProvider | null;
  trigger: "manual" | "immediate";
}): TaskWorkflowFormStep {
  return {
    key: input.key,
    name: input.name,
    prompt: "",
    provider: input.provider,
    model: null,
    modeId: null,
    thinkingOptionId: null,
    workspaceMode: "worktree",
    // On by default: a step whose agent stopped without touching the checkout
    // has not done the thing, and treating that as success is how a board ends
    // up full of work nobody did.
    requireChanges: true,
    verifyCommand: "",
    timeoutMinutes: "",
    trigger: input.trigger,
  };
}

function resolveAutoContinue(steps: readonly Pick<Step, "trigger">[]): boolean {
  return steps.slice(1).every((step) => step.trigger.type !== "manual");
}

/** The first step always waits for the task to be started. Scheduled steps
 * keep their cadence; the plan-level switch owns ordinary later steps. */
function applyAutoContinue(
  steps: readonly TaskWorkflowFormStep[],
  autoContinue: boolean,
): TaskWorkflowFormStep[] {
  return steps.map((step, index) => {
    if (index === 0) {
      return withPositionValidChoices(step, index);
    }
    if (step.trigger === "schedule") {
      return step;
    }
    return { ...step, trigger: autoContinue ? "immediate" : "manual" };
  });
}

/**
 * A stored step read back into the form.
 *
 * Settings the form cannot author — an `existing` workspace, a scheduled
 * trigger — are carried as they are rather than rewritten to something the
 * form can draw. The author sees what the step actually does and changes it
 * only by choosing something else.
 */
function toFormStep(input: {
  key: string;
  step: Step;
  fallbackProvider: AgentProvider | null;
}): TaskWorkflowFormStep {
  const spec = input.step.agents[0];
  const workspaceMode = input.step.workspace.mode;
  const trigger = input.step.trigger.type;
  return {
    source: input.step,
    key: input.key,
    name: input.step.name,
    prompt: input.step.prompt,
    provider: spec?.provider ?? input.fallbackProvider,
    model: spec?.model ?? null,
    modeId: spec?.modeId ?? null,
    thinkingOptionId: spec?.thinkingOptionId ?? null,
    ...(spec?.featureValues ? { featureValues: spec.featureValues } : {}),
    requireChanges: input.step.requireChanges === true,
    verifyCommand: input.step.verify?.command.join(" ") ?? "",
    timeoutMinutes: input.step.timeoutMs
      ? String(Math.max(1, Math.round(input.step.timeoutMs / 60_000)))
      : "",
    workspaceMode,
    trigger,
  };
}

export function openTaskWorkflowForm(snapshot: TaskWorkflowFormSnapshot): TaskWorkflowFormModel {
  const listeners = new Set<() => void>();
  let closed = false;
  let existingStepsResolved = (snapshot.existingSteps?.length ?? 0) > 0;
  let nextStepKey = 1;
  const initialProviderOptions = buildProviderChoices(snapshot.availableProviders ?? []);
  const initialProvider = initialProviderOptions[0]?.value ?? null;

  const existing = snapshot.existingSteps ?? [];
  const initialAutoContinue = resolveAutoContinue(existing);
  const initialSteps =
    existing.length > 0
      ? existing.map((step) =>
          toFormStep({ key: `step-${nextStepKey++}`, step, fallbackProvider: initialProvider }),
        )
      : [
          createStep({
            key: `step-${nextStepKey++}`,
            name: "",
            provider: initialProvider,
            trigger: "manual",
          }),
        ];
  let state: TaskWorkflowFormState = {
    serverId: snapshot.serverId,
    taskId: snapshot.taskId,
    cwd: snapshot.cwd ?? null,
    autoContinue: initialAutoContinue,
    steps: applyAutoContinue(initialSteps, initialAutoContinue),
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
    applyCwd(serverId, cwd) {
      if (closed || state.serverId !== serverId || state.cwd === cwd) {
        return;
      }
      publish({ ...state, cwd });
    },
    applyProviderSnapshot(serverId, providers) {
      if (closed || state.serverId !== serverId) {
        return;
      }
      const providerOptions = buildProviderChoices(providers);
      const fallback = providerOptions[0]?.value ?? null;
      publish({
        ...state,
        // A stored provider the host cannot currently run stays on the step and
        // stays listed. Replacing it here would rewrite a workflow the author
        // only opened to read, and the host being offline for a minute is not
        // the author changing their mind.
        providerOptions: withStepProviders(providerOptions, state.steps),
        steps: state.steps.map((step) =>
          step.provider
            ? step
            : {
                ...step,
                provider: fallback,
                model: null,
                modeId: null,
                thinkingOptionId: null,
                featureValues: undefined,
              },
        ),
        providerResolutionStatus: "complete",
      });
    },
    applyExistingSteps(serverId, taskId, steps) {
      if (
        closed ||
        existingStepsResolved ||
        state.serverId !== serverId ||
        state.taskId !== taskId
      ) {
        return;
      }
      if (steps.length === 0) {
        return;
      }
      existingStepsResolved = true;
      const fallback = state.providerOptions[0]?.value ?? null;
      const loadedAutoContinue = resolveAutoContinue(steps);
      const formSteps = applyAutoContinue(
        steps.map((step) =>
          toFormStep({ key: `step-${nextStepKey++}`, step, fallbackProvider: fallback }),
        ),
        loadedAutoContinue,
      );
      publish({
        ...state,
        autoContinue: loadedAutoContinue,
        steps: formSteps,
        providerOptions: withStepProviders(state.providerOptions, formSteps),
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
            trigger: state.autoContinue ? "immediate" : "manual",
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
      publish({ ...state, steps: applyAutoContinue(steps, state.autoContinue) });
    },
    setAutoContinue(value) {
      publish({
        ...state,
        autoContinue: value,
        steps: applyAutoContinue(state.steps, value),
      });
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
    setStepMode(key, modeId) {
      updateStep(key, (step) => ({ ...step, modeId }));
    },
    setStepThinking(key, thinkingOptionId) {
      updateStep(key, (step) => ({ ...step, thinkingOptionId }));
    },
    setStepFeatureValues(key, featureValues) {
      updateStep(key, (step) => ({ ...step, featureValues }));
    },
    setStepWorkspaceMode(key, mode) {
      updateStep(key, (step) => ({ ...step, workspaceMode: mode }));
    },
    setStepRequireChanges(key, requireChanges) {
      updateStep(key, (step) => ({ ...step, requireChanges }));
    },
    setStepVerifyCommand(key, verifyCommand) {
      updateStep(key, (step) => ({ ...step, verifyCommand }));
    },
    setStepTimeoutMinutes(key, timeoutMinutes) {
      updateStep(key, (step) => ({ ...step, timeoutMinutes }));
    },
    setSubmitError(value) {
      publish({ ...state, submitError: value });
    },
  };
}

/** The evidence fields, as the wire wants them: a command split on spaces and
 * minutes turned into milliseconds. Blank fields ask for nothing. */
function buildStepEvidence(step: TaskWorkflowFormStep): {
  verify?: { command: string[] };
  timeoutMs?: number;
} {
  const command = step.verifyCommand.trim().split(/\s+/).filter(Boolean);
  const minutes = Number.parseInt(step.timeoutMinutes.trim(), 10);
  return {
    ...(command.length > 0 ? { verify: { command } } : {}),
    ...(Number.isFinite(minutes) && minutes > 0 ? { timeoutMs: minutes * 60_000 } : {}),
  };
}

/**
 * The agents to save. The first is the one the form edits; the rest are put
 * back untouched. The first agent's complete execution configuration is owned
 * by the form; provider-only fields it does not understand are carried through.
 */
function buildStepAgents(step: TaskWorkflowFormStep, provider: AgentProvider): StepInput["agents"] {
  const [first, ...rest] = step.source?.agents ?? [];
  const {
    provider: _provider,
    model: _model,
    modeId: _modeId,
    thinkingOptionId: _thinkingOptionId,
    featureValues: _featureValues,
    ...carried
  } = first ?? { provider };
  return [
    {
      ...carried,
      provider,
      ...(step.model ? { model: step.model } : {}),
      ...(step.modeId ? { modeId: step.modeId } : {}),
      ...(step.thinkingOptionId ? { thinkingOptionId: step.thinkingOptionId } : {}),
      ...(step.featureValues ? { featureValues: step.featureValues } : {}),
    },
    ...rest,
  ];
}

/** Keeps a stored strategy the form cannot author, and only that one: any other
 * mode is a choice the author made here. */
function buildStepWorkspace(step: TaskWorkflowFormStep): StepWorkspaceStrategy {
  const stored = step.source?.workspace;
  if (step.workspaceMode === "existing") {
    return stored?.mode === "existing" ? stored : { mode: "worktree" };
  }
  return { mode: step.workspaceMode };
}

function buildStepTrigger(step: TaskWorkflowFormStep): StepTrigger {
  const stored = step.source?.trigger;
  if (step.trigger === "schedule") {
    return stored?.type === "schedule" ? stored : { type: "manual" };
  }
  return { type: step.trigger };
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
      ...(step.source ? { existingStepId: step.source.id } : {}),
      name: step.name.trim(),
      // The task brief is always in the generated prompt. A blank per-action
      // brief means the action label itself is the only extra instruction.
      prompt: step.prompt.trim() || step.name.trim(),
      agents: buildStepAgents(step, provider),
      completion: "all",
      workspace: buildStepWorkspace(step),
      trigger: buildStepTrigger(step),
      requireChanges: step.requireChanges,
      ...buildStepEvidence(step),
    });
  }
  return steps;
}
