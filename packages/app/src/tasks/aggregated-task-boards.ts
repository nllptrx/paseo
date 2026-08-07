import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { Task, TaskLabel, TaskProject } from "@getpaseo/protocol/tasks/types";
import { toErrorMessage } from "@/utils/error-messages";

export const taskBoardsQueryBaseKey = ["task-boards"] as const;

export const ALL_TASK_HOSTS_FAILED_MESSAGE = "No connected hosts could load boards";

export interface TaskBoardHostInput {
  serverId: string;
  serverName: string;
  /** Whether this host has a tracker at all. A host without one is skipped, not
   * asked and failed: "this daemon has no tracker" is a fact about the host, not
   * an error to show. */
  supportsTasks: boolean;
}

export interface TaskBoardRuntimeSnapshot {
  connectionStatus: string;
}

export interface TaskBoardRuntime {
  getClient(serverId: string): Pick<DaemonClient, "tasksSnapshot"> | null;
  getSnapshot(serverId: string): TaskBoardRuntimeSnapshot | null | undefined;
}

/**
 * A board is a tracker project, tagged with the host it came from. The tasks
 * travel with it: the overview draws cards, and refetching per column would ask
 * one host the same question once per board it owns.
 */
export interface AggregatedTaskBoard {
  serverId: string;
  serverName: string;
  project: TaskProject;
  tasks: Task[];
  labels: TaskLabel[];
}

export interface TaskBoardHostError {
  serverId: string;
  serverName: string;
  message: string;
}

export type FetchAggregatedTaskBoardsState =
  | { status: "connecting" }
  | { status: "loaded"; data: AggregatedTaskBoard[]; hostErrors: TaskBoardHostError[] };

export interface FetchAggregatedTaskBoardsInput {
  hosts: readonly TaskBoardHostInput[];
  runtime: TaskBoardRuntime;
}

/**
 * Fetch every host's tracker and split each snapshot into one board per
 * project. Connectivity is checked at execution time so an explicit refresh
 * picks up the currently connected hosts.
 *
 * Offline hosts are skipped. A connected host that fails contributes to
 * `hostErrors` — surfaced as a banner — while the rest still render; only when
 * every connected host fails does this throw so the screen shows one error
 * instead of an empty board list that looks like "you have no boards".
 */
export async function fetchAggregatedTaskBoards(
  input: FetchAggregatedTaskBoardsInput,
): Promise<FetchAggregatedTaskBoardsState> {
  const hasSettlingHost = input.hosts.some((host) =>
    isConnectionSettling(input.runtime.getSnapshot(host.serverId)),
  );
  const hasAskableHost = input.hosts.some((host) => {
    const snapshot = input.runtime.getSnapshot(host.serverId);
    return (
      host.supportsTasks &&
      snapshot?.connectionStatus === "online" &&
      Boolean(input.runtime.getClient(host.serverId))
    );
  });

  if (!hasAskableHost && hasSettlingHost) {
    return { status: "connecting" };
  }

  const boards: AggregatedTaskBoard[] = [];
  const hostErrors: TaskBoardHostError[] = [];
  let connectedAttempts = 0;

  await Promise.all(
    input.hosts.map(async (host) => {
      const snapshot = input.runtime.getSnapshot(host.serverId);
      const client = input.runtime.getClient(host.serverId);
      if (!client || snapshot?.connectionStatus !== "online" || !host.supportsTasks) {
        return;
      }
      connectedAttempts += 1;
      try {
        const payload = await client.tasksSnapshot();
        if (payload.error || !payload.snapshot) {
          throw new Error(payload.error ?? "The host returned no tracker snapshot");
        }
        for (const board of splitSnapshotIntoBoards(payload.snapshot, host)) {
          boards.push(board);
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

  if (connectedAttempts > 0 && boards.length === 0 && hostErrors.length === connectedAttempts) {
    throw new Error(ALL_TASK_HOSTS_FAILED_MESSAGE);
  }

  if (boards.length === 0 && hasSettlingHost) {
    return { status: "connecting" };
  }

  return { status: "loaded", data: boards, hostErrors };
}

export function splitSnapshotIntoBoards(
  snapshot: { projects: TaskProject[]; tasks: Task[]; labels: TaskLabel[] },
  host: TaskBoardHostInput,
): AggregatedTaskBoard[] {
  return snapshot.projects.map((project) => ({
    serverId: host.serverId,
    serverName: host.serverName,
    project,
    tasks: snapshot.tasks.filter((task) => task.projectId === project.id),
    labels: snapshot.labels.filter((label) => label.projectId === project.id),
  }));
}

/** The board behind a route param, or null while the hosts are still answering. */
export function findBoardById(
  boards: readonly AggregatedTaskBoard[],
  projectId: string,
): AggregatedTaskBoard | null {
  return boards.find((board) => board.project.id === projectId) ?? null;
}

function isConnectionSettling(snapshot: TaskBoardRuntimeSnapshot | null | undefined): boolean {
  if (!snapshot) {
    return true;
  }
  return snapshot.connectionStatus === "connecting" || snapshot.connectionStatus === "idle";
}
