import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { TaskPreset } from "@getpaseo/protocol/tasks/types";
import { useFetchQuery } from "@/data/query";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { tasksQueryKey } from "@/tasks/task-query-keys";
import { useTasksSupported } from "@/tasks/use-tasks";

const PRESETS_QUERY_ROOT = "task-presets";

export interface CreateTaskPresetDraft {
  name: string;
  provider: string;
  model?: string | null;
  modeId?: string | null;
  thinkingOptionId?: string | null;
  featureValues?: Record<string, unknown>;
  instructions?: string;
  environmentKind: "project_default" | "new_worktree";
}

/** Saving and removing the named ways to run work. Presets are host-wide: a
 * way of working is not a property of one board. */
export function useTaskPresetMutations(serverId: string): {
  createPreset: (draft: CreateTaskPresetDraft) => Promise<void>;
  deletePreset: (presetId: string) => Promise<void>;
  isBusy: boolean;
} {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const queryClient = useQueryClient();

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: [PRESETS_QUERY_ROOT, serverId] });
  };

  const create = useMutation({
    mutationFn: async (draft: CreateTaskPresetDraft) => {
      if (!client) {
        throw new Error(t("common.errors.daemonClientUnavailable"));
      }
      const payload = await client.tasksPresetCreate({
        name: draft.name,
        provider: draft.provider,
        model: draft.model ?? null,
        modeId: draft.modeId ?? null,
        thinkingOptionId: draft.thinkingOptionId ?? null,
        featureValues: draft.featureValues,
        instructions: draft.instructions ?? "",
        environmentKind: draft.environmentKind,
      });
      if (payload.error) {
        throw new Error(payload.error);
      }
    },
    onSettled: invalidate,
  });

  const remove = useMutation({
    mutationFn: async (presetId: string) => {
      if (!client) {
        throw new Error(t("common.errors.daemonClientUnavailable"));
      }
      const payload = await client.tasksPresetDelete(presetId);
      if (payload.error) {
        throw new Error(payload.error);
      }
    },
    onSettled: invalidate,
  });

  return {
    createPreset: async (draft) => {
      await create.mutateAsync(draft);
    },
    deletePreset: async (presetId) => {
      await remove.mutateAsync(presetId);
    },
    isBusy: create.isPending || remove.isPending,
  };
}

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
export interface TaskDelegateInput {
  taskId: string;
  presetId?: string;
  agent?: {
    provider: string;
    model?: string | null;
    modeId?: string | null;
    thinkingOptionId?: string | null;
    featureValues?: Record<string, unknown>;
    environmentKind?: "project_default" | "new_worktree";
  };
}

export function useTaskDelegate(serverId: string): {
  delegate: (input: TaskDelegateInput) => Promise<void>;
  isDelegating: boolean;
} {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: async (input: TaskDelegateInput) => {
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
