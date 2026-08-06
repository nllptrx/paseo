import type { Command } from "commander";
import type { ListResult } from "../../../output/index.js";
import { planSchema, toPlanRow, type PlanRow } from "./schema.js";
import {
  connectKanbanClient,
  fetchKanban,
  requireString,
  toKanbanCommandError,
  type PlanCommandOptions,
} from "./shared.js";

export async function runLsCommand(
  options: PlanCommandOptions,
  _command: Command,
): Promise<ListResult<PlanRow>> {
  const kanbanId = requireString(options.kanban, "--kanban");
  const { client } = await connectKanbanClient(options.host);
  try {
    const kanban = await fetchKanban(client, kanbanId);
    const plans = options.parent
      ? Object.values(resolveNestedPlans(kanban, options.parent))
      : Object.values(kanban.plans);
    return {
      type: "list",
      data: plans.map((plan) => toPlanRow(plan)),
      schema: planSchema,
    };
  } catch (error) {
    throw toKanbanCommandError("PLAN_LIST_FAILED", "list plans", error);
  } finally {
    await client.close().catch(() => {});
  }
}

function resolveNestedPlans(kanban: Awaited<ReturnType<typeof fetchKanban>>, parentPlanId: string) {
  const parent = kanban.plans[parentPlanId];
  if (!parent || parent.body.type !== "nested_kanban") {
    throw new Error(`Nested kanban plan not found: ${parentPlanId}`);
  }
  return parent.body.plans;
}
