import type { AgentProvider } from "@getpaseo/protocol/agent-types";
import type { Step } from "@getpaseo/protocol/kanban/types";

export interface KanbanProviderAvailability {
  provider: AgentProvider;
  available: boolean;
  error: string | null;
}

export interface StepDispatchBlock {
  provider: AgentProvider;
  reason: string | null;
}

/**
 * Why a step cannot be dispatched, or null when it can.
 *
 * A step whose agent the host cannot run fails somewhere inside the dispatch,
 * where the answer reads as a run that went wrong rather than as a provider that
 * was never usable. Checking first turns that into a sentence naming the
 * provider, which is the thing the reader has to go and fix.
 *
 * `null` availability means the host has not answered yet. That is not a reason
 * to refuse — the daemon still decides — so an unanswered listing lets the
 * dispatch through.
 */
export function resolveStepDispatchBlock(input: {
  step: Step;
  providers: readonly KanbanProviderAvailability[] | null;
}): StepDispatchBlock | null {
  const { step, providers } = input;
  if (providers === null) {
    return null;
  }
  for (const agent of step.agents) {
    const entry = providers.find((candidate) => candidate.provider === agent.provider);
    if (!entry) {
      return { provider: agent.provider, reason: null };
    }
    if (!entry.available) {
      return { provider: agent.provider, reason: entry.error };
    }
  }
  return null;
}
