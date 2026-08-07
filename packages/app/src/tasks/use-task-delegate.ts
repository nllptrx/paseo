import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { TaskPreset } from "@getpaseo/protocol/tasks/types";
import { useFetchQuery } from "@/data/query";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { tasksQueryKey } from "@/tasks/task-query-keys";
import { useTasksSupported } from "@/tasks/use-tasks";

const PRESETS_QUERY_ROOT = "task-presets";

export function useTaskPresets(serverId: string): { presets: TaskPreset[]; isLoading: boolean } {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const supported = useTasksSupported(serverId);
  const enabled = Boolean(client && isConnected && supported);

  const query = useFetchQuery({
    queryKey: [PRESETS_QUERY_ROOT, serverId],
    enabled,
    dataShape: "list",
    staleTimeMs: 30_000,
    queryFn: async (): Promise<TaskPreset[]> => {
      if (!client) {
        throw new Error(t("common.errors.daemonClientUnavailable"));
      }
      const payload = await client.tasksPresetList();
      if (payload.error) {
        throw new Error(payload.error);
      }
      return payload.presets;
    },
  });

  return { presets: query.data ?? [], isLoading: enabled && query.isPending };
}

/**
 * Starts work on a card from a preset. The daemon refuses when the task still
 * has open blockers, so the error a caller shows is the tracker's own words
 * about which ones.
 */
export function useTaskDelegate(serverId: string): {
  delegate: (input: { taskId: string; presetId: string }) => Promise<void>;
  isDelegating: boolean;
} {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: async (input: { taskId: string; presetId: string }) => {
      if (!client) {
        throw new Error(t("common.errors.daemonClientUnavailable"));
      }
      const payload = await client.tasksDelegate(input);
      if (payload.error) {
        throw new Error(payload.error);
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: tasksQueryKey(serverId) });
    },
  });

  return {
    delegate: async (input) => {
      await mutation.mutateAsync(input);
    },
    isDelegating: mutation.isPending,
  };
}
