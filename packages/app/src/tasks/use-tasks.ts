import { useCallback } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { TaskSnapshot, TaskStatus } from "@getpaseo/protocol/tasks/types";
import { useFetchQuery } from "@/data/query";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";

export const tasksQueryBaseKey = ["tasks-snapshot"] as const;

export function tasksQueryKey(serverId: string) {
  return [...tasksQueryBaseKey, serverId] as const;
}

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

  const query = useFetchQuery({
    queryKey: tasksQueryKey(serverId),
    enabled: Boolean(client && isConnected && supported),
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

export interface UseTaskMutationsResult {
  createProject: (input: { name: string; prefix: string; color: string }) => Promise<string>;
  createTask: (input: { projectId: string; title: string; description?: string }) => Promise<void>;
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
    mutationFn: async (input: { name: string; prefix: string; color: string }) => {
      const payload = await require().tasksProjectCreate(input);
      if (payload.error || !payload.project) {
        throw new Error(payload.error ?? "The host created no project");
      }
      return payload.project.id;
    },
    onSettled: invalidate,
  });

  const createTask = useMutation({
    mutationFn: async (input: { projectId: string; title: string; description?: string }) => {
      const payload = await require().tasksCreate(input);
      if (payload.error) {
        throw new Error(payload.error);
      }
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
    setStatus: (input) => update.mutateAsync({ taskId: input.taskId, status: input.status }),
    setPriority: (input) => update.mutateAsync({ taskId: input.taskId, priority: input.priority }),
    deleteTask: (taskId) => remove.mutateAsync(taskId),
    isBusy: createProject.isPending || createTask.isPending || update.isPending || remove.isPending,
  };
}
