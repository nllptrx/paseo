import { useMemo } from "react";
import { useFetchQuery } from "@/data/query";
import { tasksPushRoute } from "@/data/push-router";
import {
  getHostRuntimeStore,
  useHostRuntimeConnectionStatuses,
  useHosts,
} from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import {
  fetchAggregatedTaskBoards,
  taskBoardsQueryBaseKey,
  type AggregatedTaskBoard,
  type TaskBoardHostError,
  type TaskBoardHostInput,
} from "@/tasks/aggregated-task-boards";

export type { AggregatedTaskBoard, TaskBoardHostError } from "@/tasks/aggregated-task-boards";

export type TaskBoardsLoadState =
  | { status: "connecting" }
  | { status: "loading" }
  | { status: "loaded"; data: AggregatedTaskBoard[] };

export function taskBoardsQueryKey(serverIds: readonly string[]) {
  return [...taskBoardsQueryBaseKey, [...serverIds].sort().join("|")] as const;
}

export interface UseTaskBoardsResult {
  loadState: TaskBoardsLoadState;
  hostErrors: TaskBoardHostError[];
  isError: boolean;
  error: Error | null;
  refetch: () => void;
  isRefetching: boolean;
}

/** Every host's boards in one list, for the cross-project overview. A single
 * board screen reads its host's tracker directly instead. */
export function useTaskBoards(): UseTaskBoardsResult {
  const hosts = useHosts();
  const runtime = getHostRuntimeStore();
  const sessions = useSessionStore((state) => state.sessions);
  const hostInputs = useMemo<TaskBoardHostInput[]>(
    () =>
      hosts.map((host) => ({
        serverId: host.serverId,
        serverName: host.label,
        supportsTasks: sessions[host.serverId]?.serverInfo?.features?.tasks === true,
      })),
    [hosts, sessions],
  );
  const serverIds = useMemo(() => hostInputs.map((host) => host.serverId), [hostInputs]);
  const connectionStatuses = useHostRuntimeConnectionStatuses(serverIds);
  // Support is part of the key: a host that gains its tracker after connecting
  // has to make the list refetch, not sit behind a cached "no boards".
  const hostStateKey = useMemo(
    () =>
      hostInputs
        .map(
          (host) =>
            `${host.serverId}:${connectionStatuses.get(host.serverId) ?? "connecting"}:${host.supportsTasks}`,
        )
        .join("|"),
    [connectionStatuses, hostInputs],
  );

  const query = useFetchQuery({
    queryKey: [...taskBoardsQueryKey(serverIds), hostStateKey],
    queryFn: () => fetchAggregatedTaskBoards({ hosts: hostInputs, runtime }),
    dataShape: "list",
    staleTimeMs: 5_000,
    meta: tasksPushRoute({ enabled: serverIds.length > 0, serverIds }),
  });

  let loadState: TaskBoardsLoadState;
  if (query.data?.status === "connecting") {
    loadState = { status: "connecting" };
  } else if (query.data?.status === "loaded") {
    loadState = { status: "loaded", data: query.data.data };
  } else {
    loadState = { status: "loading" };
  }

  return {
    loadState,
    hostErrors: query.data?.status === "loaded" ? query.data.hostErrors : [],
    isError: query.isError,
    error: query.error,
    refetch: () => {
      void query.refetch();
    },
    isRefetching: query.isRefetching,
  };
}
