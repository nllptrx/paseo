import type { ManagedAgent } from "./agent-manager.js";

export type AgentCompletionOutcome = "finished" | "errored" | "closed" | null;

export interface AgentCompletionObserver {
  /**
   * Feed the next `agent_state` lifecycle for this agent (or its snapshot at
   * setup time) and get back the outcome to report, if any.
   *
   * Do NOT treat an immediate "idle" as "finished" — the agent may not have
   * started yet (streamAgent sets a pending run before transitioning to
   * "running"). "finished" only fires after a "running" has been observed.
   */
  observeLifecycle(lifecycle: ManagedAgent["lifecycle"]): AgentCompletionOutcome;
}

export function observeAgentCompletion(): AgentCompletionObserver {
  let hasSeenRunning = false;

  return {
    observeLifecycle(lifecycle) {
      if (lifecycle === "running") {
        hasSeenRunning = true;
        return null;
      }
      if (lifecycle === "error") {
        return "errored";
      }
      if (lifecycle === "idle" && hasSeenRunning) {
        return "finished";
      }
      if (lifecycle === "closed") {
        return "closed";
      }
      return null;
    },
  };
}
