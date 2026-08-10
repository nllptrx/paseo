import type { Step } from "@getpaseo/protocol/tasks/workflow";

export interface StepAgentTarget {
  agentId: string;
  workspaceId: string;
}

/** A run stores agent and workspace ids in matching positions. The latest run
 * owns the row link: retries must open the current conversation, not a stale
 * agent from the run before it. */
export function resolveStepAgentTarget(step: Step): StepAgentTarget | null {
  const run = step.runs.at(-1);
  if (!run) return null;
  for (const [index, agentId] of run.agentIds.entries()) {
    const workspaceId = run.workspaceIds[index];
    if (workspaceId) return { agentId, workspaceId };
  }
  return null;
}
