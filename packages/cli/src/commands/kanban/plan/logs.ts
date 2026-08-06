import type { Command } from "commander";
import type { ListResult } from "../../../output/index.js";
import { planLogSchema, toPlanLogRows, type PlanLogRow } from "./schema.js";
import {
  connectKanbanClient,
  fetchKanban,
  findPlan,
  requireString,
  toKanbanCommandError,
  type PlanCommandOptions,
} from "./shared.js";

export interface PlanLogsOptions extends PlanCommandOptions {
  step?: string;
}

export async function runLogsCommand(
  id: string,
  options: PlanLogsOptions,
  _command: Command,
): Promise<ListResult<PlanLogRow>> {
  const kanbanId = requireString(options.kanban, "--kanban");
  const { client } = await connectKanbanClient(options.host);
  try {
    const kanban = await fetchKanban(client, kanbanId);
    const plan = findPlan(kanban, id, options.parent);
    return {
      type: "list",
      data: toPlanLogRows(plan, options.step),
      schema: planLogSchema,
    };
  } catch (error) {
    throw toKanbanCommandError("PLAN_LOGS_FAILED", "show plan logs", error);
  } finally {
    await client.close().catch(() => {});
  }
}
