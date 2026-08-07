import { useCallback } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { Task, TaskSnapshot, TaskStatus } from "@getpaseo/protocol/tasks/types";
import { useFetchQuery } from "@/data/query";
import { tasksPushRoute } from "@/data/push-router";
import { tasksQueryBaseKey, tasksQueryKey } from "@/tasks/task-query-keys";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";

export { tasksQueryBaseKey, tasksQueryKey } from "@/tasks/task-query-keys";

/** The tracker is host-local, and the host says whether it has one at all. */
export function useTasksSupported(serverId: string): boolean {
  return useSessionStore((state) => state.sessions[serverId]?.serverInfo?.features?.tasks === true);
}

export interface UseTasksResult {
  snapshot: TaskSnapshot | null;
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  refetch: () => void;
}

export function useTasks(serverId: string): UseTasksResult {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const supported = useTasksSupported(serverId);

  const enabled = Boolean(client && isConnected && supported);
  const query = useFetchQuery({
    queryKey: tasksQueryKey(serverId),
    enabled,
    meta: tasksPushRoute({ enabled, serverId }),
    dataShape: "value",
    staleTimeMs: 2_000,
    queryFn: async (): Promise<TaskSnapshot | null> => {
      if (!client) {
        throw new Error(t("common.errors.daemonClientUnavailable"));
      }
      const payload = await client.tasksSnapshot();
      if (payload.error) {
        throw new Error(payload.error);
      }
      return payload.snapshot;
    },
  });

  return {
    snapshot: query.data ?? null,
    isLoading: query.isPending && Boolean(client && isConnected && supported),
    isError: query.isError,
    error: query.error,
    refetch: () => {
      void query.refetch();
    },
  };
}

export interface TaskMovePatch {
  taskId: string;
  status: TaskStatus;
  beforePosition: number | null;
  afterPosition: number | null;
}

/** The optimistic guess for where the daemon will put the task. It uses the
 * midpoint the daemon would pick from the same neighbours, so the board settles
 * without a jump when the write lands. */
/** Mirrors the daemon's `POSITION_STEP` arithmetic in the tasks store, so the
 * optimistic paint and the settled write agree and the card does not jump. */
const POSITION_STEP = 1024;

function guessMovePosition(before: number | null, after: number | null): number {
  if (before !== null && after !== null) {
    return (before + after) / 2;
  }
  if (before !== null) {
    return before + POSITION_STEP;
  }
  if (after !== null) {
    return after - POSITION_STEP;
  }
  return POSITION_STEP;
}

function applyMoveToSnapshot(snapshot: TaskSnapshot, move: TaskMovePatch): TaskSnapshot {
  const position = guessMovePosition(move.beforePosition, move.afterPosition);
  const tasks: Task[] = snapshot.tasks.map((task) =>
    task.id === move.taskId ? { ...task, status: move.status, position } : task,
  );
  return { ...snapshot, tasks };
}

export interface UseTaskMutationsResult {
  createProject: (input: {
    name: string;
    prefix: string;
    color: string;
    paseoProjectId?: string | null;
  }) => Promise<string>;
  createTask: (input: {
    projectId: string;
    title: string;
    description?: string;
    status?: TaskStatus;
  }) => Promise<void>;
  moveTask: (input: TaskMovePatch) => Promise<void>;
  setStatus: (input: { taskId: string; status: TaskStatus }) => Promise<void>;
  setPriority: (input: {
    taskId: string;
    priority: "urgent" | "high" | "medium" | "low" | "none";
  }) => Promise<void>;
  deleteTask: (taskId: string) => Promise<void>;
  isBusy: boolean;
}

export function useTaskMutations(serverId: string): UseTaskMutationsResult {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const queryClient = useQueryClient();

  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: tasksQueryKey(serverId) });
  }, [queryClient, serverId]);

  const require = useCallback(() => {
    if (!client) {
      throw new Error(t("common.errors.daemonClientUnavailable"));
    }
    return client;
  }, [client, t]);

  const createProject = useMutation({
    mutationFn: async (input: {
      name: string;
      prefix: string;
      color: string;
      paseoProjectId?: string | null;
    }) => {
      const payload = await require().tasksProjectCreate(input);
      if (payload.error || !payload.project) {
        throw new Error(payload.error ?? "The host created no project");
      }
      return payload.project.id;
    },
    onSettled: invalidate,
  });

  const createTask = useMutation({
    mutationFn: async (input: {
      projectId: string;
      title: string;
      description?: string;
      status?: TaskStatus;
    }) => {
      const payload = await require().tasksCreate(input);
      if (payload.error) {
        throw new Error(payload.error);
      }
    },
    onSettled: invalidate,
  });

  // The card moves the moment it is dropped. The daemon still picks the real
  // position from the neighbours; the refetch on settle reconciles the guess.
  const move = useMutation({
    mutationFn: async (input: TaskMovePatch) => {
      const payload = await require().tasksMove(input);
      if (payload.error) {
        throw new Error(payload.error);
      }
    },
    onMutate: async (input: TaskMovePatch) => {
      await queryClient.cancelQueries({ queryKey: tasksQueryKey(serverId) });
      queryClient.setQueryData<TaskSnapshot | null>(tasksQueryKey(serverId), (snapshot) =>
        snapshot ? applyMoveToSnapshot(snapshot, input) : snapshot,
      );
    },
    onSettled: invalidate,
  });

  const update = useMutation({
    mutationFn: async (input: Parameters<DaemonClient["tasksUpdate"]>[0]) => {
      const payload = await require().tasksUpdate(input);
      if (payload.error) {
        throw new Error(payload.error);
      }
    },
    onSettled: invalidate,
  });

  const remove = useMutation({
    mutationFn: async (taskId: string) => {
      const payload = await require().tasksDelete(taskId);
      if (payload.error) {
        throw new Error(payload.error);
      }
    },
    onSettled: invalidate,
  });

  return {
    createProject: (input) => createProject.mutateAsync(input),
    createTask: (input) => createTask.mutateAsync(input),
    moveTask: (input) => move.mutateAsync(input),
    setStatus: (input) => update.mutateAsync({ taskId: input.taskId, status: input.status }),
    setPriority: (input) => update.mutateAsync({ taskId: input.taskId, priority: input.priority }),
    deleteTask: (taskId) => remove.mutateAsync(taskId),
    isBusy:
      createProject.isPending ||
      createTask.isPending ||
      update.isPending ||
      move.isPending ||
      remove.isPending,
  };
}
