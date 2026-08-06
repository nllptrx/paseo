import type { AgentProvider } from "@getpaseo/protocol/agent-types";
import type { KanbanPlanCreateBody } from "@getpaseo/protocol/kanban/rpc-schemas";
import { AGENT_PROVIDER_DEFINITIONS } from "@getpaseo/protocol/provider-manifest";

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

export interface KanbanPlanFormState {
  serverId: string;
  kanbanId: string;
  parentPlanId: string | null;
  title: string;
  description: string;
  prompt: string;
  providerOptions: KanbanPlanFormProviderChoice[];
  selectedProvider: AgentProvider | null;
  selectedProviderDisplay: KanbanPlanFormDisplay | null;
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
  setPrompt: (value: string) => void;
  setProvider: (provider: AgentProvider) => void;
  setSubmitError: (value: string | null) => void;
}

function resolveProviderLabel(provider: AgentProvider): string {
  return (
    AGENT_PROVIDER_DEFINITIONS.find((definition) => definition.id === provider)?.label ?? provider
  );
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

function resolveInitialProvider(
  choices: readonly KanbanPlanFormProviderChoice[],
): AgentProvider | null {
  return choices[0]?.value ?? null;
}

function buildProviderDisplay(
  choices: readonly KanbanPlanFormProviderChoice[],
  provider: AgentProvider | null,
): KanbanPlanFormDisplay | null {
  if (!provider) {
    return null;
  }
  const choice = choices.find((entry) => entry.value === provider);
  return { label: choice?.label ?? resolveProviderLabel(provider) };
}

function resolveCanSubmit(state: KanbanPlanFormState): boolean {
  return (
    state.title.trim().length > 0 &&
    state.prompt.trim().length > 0 &&
    state.selectedProvider !== null
  );
}

export function openKanbanPlanForm(snapshot: KanbanPlanFormSnapshot): KanbanPlanFormModel {
  const listeners = new Set<() => void>();
  let closed = false;
  const initialProviderOptions = buildProviderChoices(snapshot.availableProviders ?? []);
  const initialProvider = resolveInitialProvider(initialProviderOptions);
  let state: KanbanPlanFormState = {
    serverId: snapshot.serverId,
    kanbanId: snapshot.kanbanId,
    parentPlanId: snapshot.parentPlanId,
    title: "",
    description: "",
    prompt: "",
    providerOptions: initialProviderOptions,
    selectedProvider: initialProvider,
    selectedProviderDisplay: buildProviderDisplay(initialProviderOptions, initialProvider),
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
      const selectedProvider =
        providerOptions.find((choice) => choice.value === state.selectedProvider)?.value ??
        resolveInitialProvider(providerOptions);
      publish({
        ...state,
        providerOptions,
        selectedProvider,
        selectedProviderDisplay: buildProviderDisplay(providerOptions, selectedProvider),
        providerResolutionStatus: "complete",
      });
    },
    setTitle(value) {
      publish({ ...state, title: value });
    },
    setDescription(value) {
      publish({ ...state, description: value });
    },
    setPrompt(value) {
      publish({ ...state, prompt: value });
    },
    setProvider(provider) {
      if (closed) {
        return;
      }
      publish({
        ...state,
        selectedProvider: provider,
        selectedProviderDisplay: buildProviderDisplay(state.providerOptions, provider),
      });
    },
    setSubmitError(value) {
      publish({ ...state, submitError: value });
    },
  };
}

/** Single-step manual workflow — multi-step editing is follow-up work once
 * this surface needs more than one step per plan. */
export function buildKanbanPlanCreateBody(state: KanbanPlanFormState): KanbanPlanCreateBody | null {
  if (!state.selectedProvider) {
    return null;
  }
  return {
    type: "workflow",
    steps: [
      {
        name: state.title.trim(),
        prompt: state.prompt.trim(),
        agents: [{ provider: state.selectedProvider }],
        completion: "all",
        workspace: { mode: "worktree" },
        trigger: { type: "manual" },
      },
    ],
  };
}
