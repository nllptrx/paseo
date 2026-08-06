import type { Command } from "commander";
import type { ListResult } from "../../output/index.js";
import { peerSchema, toPeerRow, type PeerRow } from "./schema.js";
import { connectKanbanClient, toKanbanCommandError, type KanbanCommandOptions } from "./shared.js";

export async function runPeersCommand(
  options: KanbanCommandOptions,
  _command: Command,
): Promise<ListResult<PeerRow>> {
  const { client } = await connectKanbanClient(options.host);
  try {
    const payload = await client.kanbanOrchestratorListPeers();
    if (payload.error) {
      throw new Error(payload.error);
    }
    return {
      type: "list",
      data: payload.peers.map(toPeerRow),
      schema: peerSchema,
    };
  } catch (error) {
    throw toKanbanCommandError("KANBAN_PEERS_FAILED", "list orchestrator peers", error);
  } finally {
    await client.close().catch(() => {});
  }
}
