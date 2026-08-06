import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { KanbanSummary } from "@getpaseo/protocol/kanban/types";
import { toErrorMessage } from "@/utils/error-messages";

export const kanbansQueryBaseKey = ["kanbans"] as const;
export const kanbanQueryBaseKey = ["kanban"] as const;

export function kanbanQueryKey(serverId: string, kanbanId: string) {
  return [...kanbanQueryBaseKey, serverId, kanbanId] as const;
}

export const ALL_KANBAN_HOSTS_FAILED_MESSAGE = "No connected hosts could load kanbans";

export interface KanbanHostInput {
  serverId: string;
  serverName: string;
}

export interface KanbanRuntimeSnapshot {
  connectionStatus: string;
}

export interface KanbanRuntime {
  getClient(serverId: string): Pick<DaemonClient, "kanbanList"> | null;
  getSnapshot(serverId: string): KanbanRuntimeSnapshot | null | undefined;
}

/** A kanban tagged with the host it came from, so the flat list can render a
 * per-row host label and scope mutations without host sections. */
export interface AggregatedKanban extends KanbanSummary {
  serverId: string;
  serverName: string;
}

export interface KanbanHostError {
  serverId: string;
  serverName: string;
  message: string;
}

export interface FetchAggregatedKanbansConnectingResult {
  status: "connecting";
}

export interface FetchAggregatedKanbansResult {
  status: "loaded";
  data: AggregatedKanban[];
  hostErrors: KanbanHostError[];
}

export type FetchAggregatedKanbansState =
  | FetchAggregatedKanbansConnectingResult
  | FetchAggregatedKanbansResult;

export type AggregateLoadState<T> =
  | { status: "connecting" }
  | { status: "loading" }
  | { status: "loaded"; data: T[] };

export interface FetchAggregatedKanbansInput {
  hosts: readonly KanbanHostInput[];
  runtime: KanbanRuntime;
}

/**
 * Fetch kanbans across connected hosts and merge them into one flat list.
 * Connectivity is checked here at execution time, so explicit query refreshes
 * pick up the currently connected host set.
 *
 * Offline hosts are skipped. A connected host that fails contributes to
 * `hostErrors` (surfaced as a banner) while the rest still render; only when
 * every connected host fails do we throw so the screen shows a full error.
 */
export async function fetchAggregatedKanbans(
  input: FetchAggregatedKanbansInput,
): Promise<FetchAggregatedKanbansState> {
  const hasSettlingHost = input.hosts.some((host) =>
    isKanbanHostConnectionSettling(input.runtime.getSnapshot(host.serverId)),
  );
  const hasAskableHost = input.hosts.some((host) => {
    const snapshot = input.runtime.getSnapshot(host.serverId);
    return snapshot?.connectionStatus === "online" && input.runtime.getClient(host.serverId);
  });

  if (!hasAskableHost && hasSettlingHost) {
    return { status: "connecting" };
  }

  const kanbans: AggregatedKanban[] = [];
  const hostErrors: KanbanHostError[] = [];
  let connectedAttempts = 0;

  await Promise.all(
    input.hosts.map(async (host) => {
      const snapshot = input.runtime.getSnapshot(host.serverId);
      const isOnline = snapshot?.connectionStatus === "online";
      const client = input.runtime.getClient(host.serverId);
      if (!client || !isOnline) {
        return;
      }
      connectedAttempts += 1;
      try {
        const payload = await client.kanbanList();
        if (payload.error) {
          throw new Error(payload.error);
        }
        for (const kanban of payload.kanbans) {
          kanbans.push({ ...kanban, serverId: host.serverId, serverName: host.serverName });
        }
      } catch (error) {
        hostErrors.push({
          serverId: host.serverId,
          serverName: host.serverName,
          message: toErrorMessage(error),
        });
      }
    }),
  );

  if (connectedAttempts > 0 && kanbans.length === 0 && hostErrors.length === connectedAttempts) {
    throw new Error(ALL_KANBAN_HOSTS_FAILED_MESSAGE);
  }

  if (kanbans.length === 0 && hasSettlingHost) {
    return { status: "connecting" };
  }

  return { status: "loaded", data: kanbans, hostErrors };
}

/** Mirrors `updateAggregatedSchedulesData`: applies a transform to the
 * canonical `loaded` list while leaving `connecting` cache entries untouched. */
export function updateAggregatedKanbansData(
  current: FetchAggregatedKanbansState | undefined,
  updateKanbans: (kanbans: AggregatedKanban[]) => AggregatedKanban[],
): FetchAggregatedKanbansState | undefined {
  if (!current || current.status !== "loaded") {
    return current;
  }
  return { ...current, data: updateKanbans(current.data) };
}

function isKanbanHostConnectionSettling(
  snapshot: KanbanRuntimeSnapshot | null | undefined,
): boolean {
  if (!snapshot) {
    return true;
  }
  return snapshot.connectionStatus === "connecting" || snapshot.connectionStatus === "idle";
}
