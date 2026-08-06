import type { Command } from "commander";
import type { OutputSchema, SingleResult } from "../../output/index.js";
import { connectKanbanClient, toKanbanCommandError, type KanbanCommandOptions } from "./shared.js";

interface KanbanArchiveRow {
  id: string;
  status: string;
}

const kanbanArchiveSchema: OutputSchema<KanbanArchiveRow> = {
  idField: "id",
  columns: [
    { header: "ID", field: "id", width: 10 },
    { header: "STATUS", field: "status", width: 12 },
  ],
};

export async function runArchiveCommand(
  id: string,
  options: KanbanCommandOptions,
  _command: Command,
): Promise<SingleResult<KanbanArchiveRow>> {
  const { client } = await connectKanbanClient(options.host);
  try {
    const payload = await client.kanbanArchive({ kanbanId: id });
    if (payload.error) {
      throw new Error(payload.error);
    }
    return {
      type: "single",
      data: { id: payload.kanbanId, status: "archived" },
      schema: kanbanArchiveSchema,
    };
  } catch (error) {
    throw toKanbanCommandError("KANBAN_ARCHIVE_FAILED", "archive kanban", error);
  } finally {
    await client.close().catch(() => {});
  }
}
