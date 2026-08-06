import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { resolveKanbanWorkspaceColumns, type KanbanColumnRef } from "./sidebar-kanban-view-model";

export const sidebarKanbanIndexQueryBaseKey = ["sidebar-kanban-index"] as const;

export function sidebarKanbanIndexQueryKey(serverIds: readonly string[]) {
  return [...sidebarKanbanIndexQueryBaseKey, [...serverIds].sort().join("|")] as const;
}

export interface SidebarKanbanIndexRuntime {
  getClient(serverId: string): Pick<DaemonClient, "kanbanList" | "kanbanGet"> | null;
}

export interface SidebarKanbanIndex {
  /** Keyed by `${serverId}:${workspaceId}`, matching `SidebarWorkspaceEntry.workspaceKey`. */
  columnRefByWorkspaceKey: Map<string, KanbanColumnRef>;
}

/**
 * Fetches every non-archived kanban on each connected host and resolves which column each
 * referenced workspace's card sits in. `kanban.list` is per-daemon (no project scoping), so one
 * call per host discovers every kanban; `kanban.get` per kanban is needed for step/plan detail
 * that the list summary omits.
 *
 * Hosts that fail or have no client contribute nothing rather than failing the whole index —
 * this only feeds an optional sidebar grouping mode, never a screen of its own.
 */
export async function fetchSidebarKanbanIndex(input: {
  serverIds: readonly string[];
  runtime: SidebarKanbanIndexRuntime;
}): Promise<SidebarKanbanIndex> {
  const columnRefByWorkspaceKey = new Map<string, KanbanColumnRef>();

  await Promise.all(
    input.serverIds.map(async (serverId) => {
      const client = input.runtime.getClient(serverId);
      if (!client) return;

      let summaries: Awaited<ReturnType<DaemonClient["kanbanList"]>>["kanbans"];
      try {
        summaries = (await client.kanbanList()).kanbans;
      } catch {
        return;
      }

      await Promise.all(
        summaries
          .filter((summary) => summary.archivedAt === null)
          .map(async (summary) => {
            let kanban: Awaited<ReturnType<DaemonClient["kanbanGet"]>>["kanban"];
            try {
              kanban = (await client.kanbanGet(summary.id)).kanban;
            } catch {
              return;
            }
            if (!kanban) return;

            for (const [workspaceId, ref] of resolveKanbanWorkspaceColumns(serverId, kanban)) {
              columnRefByWorkspaceKey.set(`${serverId}:${workspaceId}`, ref);
            }
          }),
      );
    }),
  );

  return { columnRefByWorkspaceKey };
}
