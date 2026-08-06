import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useFetchQuery } from "@/data/query";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import {
  openKanbanPlanForm,
  type KanbanPlanFormModel,
  type KanbanPlanFormProviderOption,
  type KanbanPlanFormSnapshot,
} from "./kanban-plan-form-model";

const AVAILABLE_PROVIDERS_QUERY_ROOT = "kanban-plan-form-available-providers";

export function useKanbanPlanFormModel(snapshot: KanbanPlanFormSnapshot): KanbanPlanFormModel {
  const { t } = useTranslation();
  const [model] = useState(() => openKanbanPlanForm(snapshot));

  useEffect(() => {
    return () => {
      model.close();
    };
  }, [model]);

  const client = useHostRuntimeClient(snapshot.serverId);
  const isConnected = useHostRuntimeIsConnected(snapshot.serverId);
  const availableProvidersQuery = useFetchQuery({
    queryKey: [AVAILABLE_PROVIDERS_QUERY_ROOT, snapshot.serverId],
    enabled: Boolean(client && isConnected),
    dataShape: "list",
    staleTimeMs: 30_000,
    queryFn: async (): Promise<KanbanPlanFormProviderOption[]> => {
      if (!client) {
        throw new Error(t("common.errors.daemonClientUnavailable"));
      }
      const result = await client.listAvailableProviders();
      return result.providers.map((entry) => ({
        provider: entry.provider,
        available: entry.available,
      }));
    },
  });

  useEffect(() => {
    if (!availableProvidersQuery.data) {
      return;
    }
    model.applyProviderSnapshot(snapshot.serverId, availableProvidersQuery.data);
  }, [model, availableProvidersQuery.data, snapshot.serverId]);

  return model;
}
