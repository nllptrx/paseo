import type { Command } from "commander";
import type { SingleResult } from "../../../output/index.js";
import { columnsFor, planSchema, toPlanRow, type PlanRow } from "./schema.js";
import {
  connectKanbanClient,
  fetchKanban,
  requireNonNegativeInt,
  requireString,
  toKanbanCommandError,
  type PlanCommandOptions,
} from "./shared.js";

export interface PlanMoveOptions extends PlanCommandOptions {
  column?: string;
  index?: string;
}

export async function runMoveCommand(
  planId: string,
  options: PlanMoveOptions,
  _command: Command,
): Promise<SingleResult<PlanRow>> {
  const kanbanId = requireString(options.kanban, "--kanban");
  const columnId = requireString(options.column, "--column");
  const index = requireNonNegativeInt(options.index, "--index");
  const { client } = await connectKanbanClient(options.host);
  try {
    const payload = await client.kanbanPlanMove({
      kanbanId,
      planId,
      columnId,
      index,
      movedBy: "user",
      ...(options.parent !== undefined ? { parentPlanId: options.parent } : {}),
    });
    if (payload.error || !payload.plan) {
      throw new Error(payload.error ?? `Plan move failed: ${planId}`);
    }
    const kanban = await fetchKanban(client, kanbanId);
    return {
      type: "single",
      data: toPlanRow(columnsFor(kanban, options.parent), payload.plan),
      schema: planSchema,
    };
  } catch (error) {
    throw toKanbanCommandError("PLAN_MOVE_FAILED", "move plan", error);
  } finally {
    await client.close().catch(() => {});
  }
}
