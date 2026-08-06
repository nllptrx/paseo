import type { Command } from "commander";
import type { ListResult } from "../../output/index.js";
import { kanbanSchema, toKanbanRow, type KanbanRow } from "./schema.js";
import { connectKanbanClient, toKanbanCommandError, type KanbanCommandOptions } from "./shared.js";

export async function runLsCommand(
  options: KanbanCommandOptions,
  _command: Command,
): Promise<ListResult<KanbanRow>> {
  const { client } = await connectKanbanClient(options.host);
  try {
    const payload = await client.kanbanList();
    if (payload.error) {
      throw new Error(payload.error);
    }
    return {
      type: "list",
      data: payload.kanbans.map(toKanbanRow),
      schema: kanbanSchema,
    };
  } catch (error) {
    throw toKanbanCommandError("KANBAN_LIST_FAILED", "list kanbans", error);
  } finally {
    await client.close().catch(() => {});
  }
}
