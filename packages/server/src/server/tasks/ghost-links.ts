import type { Logger } from "pino";
import type { AgentStorage } from "../agent/agent-storage.js";
import type { TaskService } from "./service.js";

export interface GhostAgentLinkPruneDeps {
  taskService: Pick<TaskService, "isAvailable" | "listAgentLinks" | "pruneAgentLinks">;
  /**
   * The authority on whether an agent still exists. `AgentManager` cannot answer
   * it — agents load on demand, so one it does not hold may simply be cold.
   */
  agentStorage: Pick<AgentStorage, "list">;
  logger: Logger;
  /**
   * Only links attached strictly before this instant are candidates. The boot
   * sweep runs while the daemon already serves traffic, and its two reads are
   * not one snapshot: a link attached mid-sweep could be read before its agent
   * record lands in storage and be deleted as a ghost. A ghost, by definition,
   * predates the sweep.
   */
  attachedBefore: string;
}

/**
 * Drops task links whose agent was deleted or archived while nobody was
 * looking. Run at boot, because a delete that happened with the daemon down left
 * no event behind, and a card that shows an agent nobody can open is worse than
 * a card that shows none.
 *
 * Returns the agent ids whose links were removed.
 */
export async function pruneGhostAgentLinks(deps: GhostAgentLinkPruneDeps): Promise<string[]> {
  if (!(await deps.taskService.isAvailable())) {
    return [];
  }
  const links = (await deps.taskService.listAgentLinks()).filter(
    (link) => link.attachedAt < deps.attachedBefore,
  );
  if (links.length === 0) {
    return [];
  }
  const live = new Set(
    (await deps.agentStorage.list())
      .filter((record) => !record.archivedAt)
      .map((record) => record.id),
  );
  const ghosts = [...new Set(links.map((link) => link.agentId))].filter(
    (agentId) => !live.has(agentId),
  );
  if (ghosts.length === 0) {
    return [];
  }
  await deps.taskService.pruneAgentLinks(ghosts);
  deps.logger.info(
    { agentIds: ghosts },
    "Pruned task agent links whose agent was deleted or archived",
  );
  return ghosts;
}
