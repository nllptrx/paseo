import { useTranslation } from "react-i18next";
import { useFetchQuery } from "@/data/query";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import type { KanbanProviderAvailability } from "./dispatch-guard";

const AVAILABLE_PROVIDERS_QUERY_ROOT = "kanban-available-providers";

/**
 * What the host can actually run. The plan form offers these as choices and the
 * board checks a dispatch against them, so both read one cached answer rather
 * than asking the daemon the same question twice.
 *
 * `null` until the host answers: absent is not the same as empty, and a caller
 * must not treat "not yet known" as "nothing available".
 */
export function useKanbanAvailableProviders(serverId: string): {
  providers: KanbanProviderAvailability[] | null;
} {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);

  const query = useFetchQuery({
    queryKey: [AVAILABLE_PROVIDERS_QUERY_ROOT, serverId],
    enabled: Boolean(client && isConnected),
    dataShape: "list",
    staleTimeMs: 30_000,
    queryFn: async (): Promise<KanbanProviderAvailability[]> => {
      if (!client) {
        throw new Error(t("common.errors.daemonClientUnavailable"));
      }
      const result = await client.listAvailableProviders();
      return result.providers.map((entry) => ({
        provider: entry.provider,
        available: entry.available,
        error: entry.error ?? null,
      }));
    },
  });

  return { providers: query.data ?? null };
}
