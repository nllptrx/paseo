import type { Command } from "commander";
import type { ListResult } from "../../../output/index.js";
import { createPlanInspectRows, createPlanInspectSchema, type PlanInspectRow } from "./schema.js";
import {
  connectKanbanClient,
  fetchKanban,
  findPlan,
  requireString,
  toKanbanCommandError,
  type PlanCommandOptions,
} from "./shared.js";

export async function runInspectCommand(
  id: string,
  options: PlanCommandOptions,
  _command: Command,
): Promise<ListResult<PlanInspectRow>> {
  const kanbanId = requireString(options.kanban, "--kanban");
  const { client } = await connectKanbanClient(options.host);
  try {
    const kanban = await fetchKanban(client, kanbanId);
    const plan = findPlan(kanban, id, options.parent);
    return {
      type: "list",
      data: createPlanInspectRows(plan),
      schema: createPlanInspectSchema(plan),
    };
  } catch (error) {
    throw toKanbanCommandError("PLAN_INSPECT_FAILED", "inspect plan", error);
  } finally {
    await client.close().catch(() => {});
  }
}
