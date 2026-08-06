import { useCallback } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { ChatMessage } from "@getpaseo/protocol/chat/types";
import { useFetchQuery } from "@/data/query";
import {
  fetchOrchestratorThread,
  orchestratorThreadQueryKey,
  postOrchestratorMessage,
} from "@/kanban/orchestrator-thread";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";

/** Chat has no push channel, so an open thread polls. */
const ORCHESTRATOR_THREAD_POLL_MS = 5_000;

export interface UseOrchestratorThreadResult {
  messages: ChatMessage[];
  roomExists: boolean;
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  refetch: () => void;
  postMessage: (body: string) => Promise<void>;
  isPosting: boolean;
}

const EMPTY_MESSAGES: ChatMessage[] = [];

export function useOrchestratorThread(input: {
  serverId: string;
  enabled: boolean;
}): UseOrchestratorThreadResult {
  const { serverId, enabled } = input;
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const queryClient = useQueryClient();
  const queryEnabled = enabled && Boolean(client) && isConnected;

  const query = useFetchQuery({
    queryKey: orchestratorThreadQueryKey(serverId),
    queryFn: () => {
      if (!client) {
        throw new Error(t("common.errors.daemonClientUnavailable"));
      }
      return fetchOrchestratorThread(client);
    },
    enabled: queryEnabled,
    dataShape: "value",
    staleTimeMs: 2_000,
    refetchInterval: queryEnabled ? ORCHESTRATOR_THREAD_POLL_MS : false,
  });

  const roomExists = Boolean(query.data?.room);

  const postMutation = useMutation({
    mutationFn: async (body: string): Promise<void> => {
      if (!client) {
        throw new Error(t("common.errors.daemonClientUnavailable"));
      }
      await postOrchestratorMessage({ client, body, roomExists });
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: orchestratorThreadQueryKey(serverId) });
    },
  });

  const postMessage = useCallback(
    async (body: string) => {
      await postMutation.mutateAsync(body);
    },
    [postMutation],
  );

  return {
    messages: query.data?.messages ?? EMPTY_MESSAGES,
    roomExists,
    isLoading: queryEnabled && query.isPending,
    isError: query.isError,
    error: query.error,
    refetch: () => {
      void query.refetch();
    },
    postMessage,
    isPosting: postMutation.isPending,
  };
}
