import { useTranslation } from "react-i18next";
import type { AgentProvider } from "@getpaseo/protocol/agent-types";
import { AGENT_PROVIDER_DEFINITIONS } from "@getpaseo/protocol/provider-manifest";
import { useFetchQuery } from "@/data/query";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";

const AVAILABLE_PROVIDERS_QUERY_ROOT = "task-available-providers";

export interface TaskProviderAvailability {
  provider: AgentProvider;
  available: boolean;
  error: string | null;
}

/**
 * What the host can actually run, cached once for everything that needs it —
 * the workflow form offers these as choices and a dispatch is checked against
 * them, so neither asks the daemon the same question twice.
 *
 * `null` until the host answers: absent is not the same as empty, and a caller
 * must not read "not yet known" as "nothing available".
 */
export function useTaskAvailableProviders(serverId: string): {
  providers: TaskProviderAvailability[] | null;
} {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);

  const query = useFetchQuery({
    queryKey: [AVAILABLE_PROVIDERS_QUERY_ROOT, serverId],
    enabled: Boolean(client && isConnected),
    dataShape: "list",
    staleTimeMs: 30_000,
    queryFn: async (): Promise<TaskProviderAvailability[]> => {
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

export function resolveProviderLabel(provider: AgentProvider): string {
  return (
    AGENT_PROVIDER_DEFINITIONS.find((definition) => definition.id === provider)?.label ?? provider
  );
}
