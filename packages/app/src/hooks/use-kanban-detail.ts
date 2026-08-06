import { useTranslation } from "react-i18next";
import { useFetchQuery } from "@/data/query";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import type { StoredKanban } from "@getpaseo/protocol/kanban/types";

export const kanbanDetailQueryBaseKey = ["kanban-detail"] as const;

export function kanbanDetailQueryKey(serverId: string, kanbanId: string) {
  return [...kanbanDetailQueryBaseKey, serverId, kanbanId] as const;
}

export interface UseKanbanDetailResult {
  kanban: StoredKanban | null;
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  refetch: () => void;
}

// TODO(kanban-data-layer): switch to the push-subscribed `kanban.subscribe.request`
// data source once it lands; this polls `kanban.get.request` like the schedules
// aggregate fetch in the meantime.
export function useKanbanDetail(serverId: string, kanbanId: string): UseKanbanDetailResult {
  const runtime = getHostRuntimeStore();
  const { t } = useTranslation();

  const query = useFetchQuery({
    queryKey: kanbanDetailQueryKey(serverId, kanbanId),
    queryFn: async (): Promise<StoredKanban | null> => {
      const client = runtime.getClient(serverId);
      if (!client) {
        throw new Error(t("common.errors.daemonClientUnavailable"));
      }
      const payload = await client.kanbanGet(kanbanId);
      if (payload.error) {
        throw new Error(payload.error);
      }
      return payload.kanban;
    },
    dataShape: "value",
    staleTimeMs: 5_000,
  });

  return {
    kanban: query.data ?? null,
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error,
    refetch: () => {
      void query.refetch();
    },
  };
}
