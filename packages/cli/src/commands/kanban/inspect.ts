import type { Command } from "commander";
import type { ListResult } from "../../output/index.js";
import {
  createKanbanInspectRows,
  createKanbanInspectSchema,
  type KanbanInspectRow,
} from "./schema.js";
import { connectKanbanClient, toKanbanCommandError, type KanbanCommandOptions } from "./shared.js";

export async function runInspectCommand(
  id: string,
  options: KanbanCommandOptions,
  _command: Command,
): Promise<ListResult<KanbanInspectRow>> {
  const { client } = await connectKanbanClient(options.host);
  try {
    const payload = await client.kanbanGet(id);
    if (payload.error || !payload.kanban) {
      throw new Error(payload.error ?? `Kanban not found: ${id}`);
    }
    return {
      type: "list",
      data: createKanbanInspectRows(payload.kanban),
      schema: createKanbanInspectSchema(payload.kanban),
    };
  } catch (error) {
    throw toKanbanCommandError("KANBAN_INSPECT_FAILED", "inspect kanban", error);
  } finally {
    await client.close().catch(() => {});
  }
}
