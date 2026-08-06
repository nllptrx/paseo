import type { KanbanPlan, NestedPlan, Step } from "@getpaseo/protocol/kanban/types";

/**
 * The distinct providers a plan's steps will run on, in first-use order. A card
 * shows these instead of a step count alone: which agent is doing the work is the
 * first thing you look for when scanning a board.
 */
export function derivePlanProviders(plan: KanbanPlan | NestedPlan): string[] {
  const providers = new Set<string>();
  const visit = (steps: Step[]) => {
    for (const step of steps) {
      for (const agent of step.agents) {
        providers.add(agent.provider);
      }
    }
  };
  if (plan.body.type === "workflow") {
    visit(plan.body.steps);
  } else {
    for (const child of Object.values(plan.body.plans)) {
      for (const provider of derivePlanProviders(child)) {
        providers.add(provider);
      }
    }
  }
  return [...providers];
}

/**
 * When the plan's current work started, for the live "worked for" label. Null once
 * nothing is running — a settled plan reports when it last changed instead.
 */
export function derivePlanActiveSince(plan: KanbanPlan | NestedPlan): Date | null {
  let earliest: number | null = null;
  const visit = (steps: Step[]) => {
    for (const step of steps) {
      const latestRun = step.runs.at(-1);
      if (latestRun?.status !== "running") {
        continue;
      }
      const startedAt = Date.parse(latestRun.startedAt);
      if (Number.isNaN(startedAt)) {
        continue;
      }
      earliest = earliest === null ? startedAt : Math.min(earliest, startedAt);
    }
  };
  if (plan.body.type === "workflow") {
    visit(plan.body.steps);
  } else {
    for (const child of Object.values(plan.body.plans)) {
      const childSince = derivePlanActiveSince(child);
      if (childSince) {
        const time = childSince.getTime();
        earliest = earliest === null ? time : Math.min(earliest, time);
      }
    }
  }
  return earliest === null ? null : new Date(earliest);
}
