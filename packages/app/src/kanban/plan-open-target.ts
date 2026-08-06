import type { KanbanPlan, NestedPlan, StepRun } from "@getpaseo/protocol/kanban/types";

/**
 * Where clicking a card should land.
 *
 * A card whose work is under way is a conversation, so it opens that agent's
 * chat: the question you have about running work is almost always "what is it
 * doing", and that answer lives in the transcript, not in a list of steps. A
 * card that has not started has no conversation to open, so it falls back to the
 * plan itself.
 */
export type PlanOpenTarget =
  | { kind: "agent"; workspaceId: string; agentId: string }
  | { kind: "plan" };

function latestRunOfEachStep(plan: KanbanPlan | NestedPlan): (StepRun | null)[] {
  if (plan.body.type === "workflow") {
    return plan.body.steps.map((step) => step.runs.at(-1) ?? null);
  }
  return Object.values(plan.body.plans).flatMap((child) => latestRunOfEachStep(child));
}

export function resolvePlanOpenTarget(plan: KanbanPlan | NestedPlan): PlanOpenTarget {
  const runs = latestRunOfEachStep(plan).filter((run) => run !== null);

  // A running step is the live conversation, so it wins over anything finished.
  const running = runs.find((run) => run.status === "running");
  const candidate = running ?? runs.at(-1);
  const agentId = candidate?.agentIds[0];
  const workspaceId = candidate?.workspaceIds[0];
  if (!agentId || !workspaceId) {
    return { kind: "plan" };
  }
  return { kind: "agent", workspaceId, agentId };
}
