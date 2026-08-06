import type { Command } from "commander";
import type { SingleResult } from "../../output/index.js";
import { kanbanSchema, toKanbanRow, type KanbanRow } from "./schema.js";
import {
  connectKanbanClient,
  resolveProjectId,
  toKanbanCommandError,
  type KanbanCommandOptions,
} from "./shared.js";

export interface KanbanCreateOptions extends KanbanCommandOptions {
  project?: string;
  name?: string;
  cwd?: string;
}

export async function runCreateCommand(
  options: KanbanCreateOptions,
  _command: Command,
): Promise<SingleResult<KanbanRow>> {
  const { client } = await connectKanbanClient(options.host);
  try {
    const projectId = await resolveProjectId(client, {
      project: options.project,
      cwd: options.cwd,
    });
    const payload = await client.kanbanCreate({
      projectId,
      ...(options.name?.trim() ? { name: options.name.trim() } : {}),
    });
    if (payload.error || !payload.kanban) {
      throw new Error(payload.error ?? "Kanban creation failed");
    }
    return {
      type: "single",
      data: toKanbanRow(payload.kanban),
      schema: kanbanSchema,
    };
  } catch (error) {
    throw toKanbanCommandError("KANBAN_CREATE_FAILED", "create kanban", error);
  } finally {
    await client.close().catch(() => {});
  }
}
