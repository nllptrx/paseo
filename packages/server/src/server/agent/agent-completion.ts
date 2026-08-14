import type { ManagedAgent } from "./agent-manager.js";

export type AgentCompletionOutcome = "finished" | "errored" | "closed" | null;

export interface AgentCompletionState {
  lifecycle: ManagedAgent["lifecycle"];
  /**
   * Whether the agent is holding at least one permission decision. A pause for
   * a person is a checkpoint in the middle of a run, not the end of one.
   */
  hasPendingPermissions: boolean;
}

export interface AgentCompletionObserver {
  /**
   * Feed the next `agent_state` for this agent (or its snapshot at setup time)
   * and get back the outcome to report, if any.
   *
   * Do NOT treat an immediate "idle" as "finished" — the agent may not have
   * started yet (streamAgent sets a pending run before transitioning to
   * "running"). "finished" only fires after a run was observed with nothing
   * waiting on a person.
   */
  observe(state: AgentCompletionState): AgentCompletionOutcome;
}

/**
 * Decides when an agent's work is over, for every caller that has to answer
 * that question: the notification a parent agent gets, and the task the agent
 * is attached to.
 *
 * A permission pause resets the run seen so far. Without that, approving a
 * permission produces an `idle` while the follow-up run starts up, and an idle
 * that follows a run reads as "finished" — settling a task, or telling a parent
 * its child is done, while the work is half way through.
 */
export function observeAgentCompletion(): AgentCompletionObserver {
  let hasSeenRunning = false;

  return {
    observe({ lifecycle, hasPendingPermissions }) {
      if (lifecycle === "error") {
        return "errored";
      }
      if (lifecycle === "closed") {
        return "closed";
      }
      if (hasPendingPermissions) {
        hasSeenRunning = false;
        return null;
      }
      if (lifecycle === "running") {
        hasSeenRunning = true;
        return null;
      }
      if (lifecycle === "idle" && hasSeenRunning) {
        return "finished";
      }
      return null;
    },
  };
}
