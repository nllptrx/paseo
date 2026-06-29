import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import type { CheckoutPipeline } from "@getpaseo/protocol/messages";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { prPanePipelineQueryKey } from "./query-keys";

/** Poll cadence for an in-progress pipeline; finished pipelines are immutable. */
const LIVE_PIPELINE_REFETCH_MS = 15_000;

export interface UseGitLabPipelineOptions {
  serverId: string;
  cwd: string;
  pipelineId: number | null;
  enabled: boolean;
  /** True while the pipeline is still running, so jobs keep refreshing. */
  live: boolean;
}

export interface UseGitLabPipelineResult {
  pipeline: CheckoutPipeline | null;
  isLoading: boolean;
  isFetching: boolean;
  error: Error | null;
}

/**
 * Fetches a GitLab pipeline through the existing forge-routed check-details RPC.
 * The pipeline id is carried in checkRunId; GitLab resolves its project from cwd.
 */
export function useGitLabPipeline({
  serverId,
  cwd,
  pipelineId,
  enabled,
  live,
}: UseGitLabPipelineOptions): UseGitLabPipelineResult {
  const daemonClient = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const shouldFetch = enabled && !!daemonClient && isConnected && !!cwd && pipelineId !== null;

  const query = useQuery<CheckoutPipeline | null>({
    queryKey: useMemo(
      () => prPanePipelineQueryKey({ serverId, cwd, pipelineId }),
      [serverId, cwd, pipelineId],
    ),
    queryFn: async () => {
      if (!daemonClient || pipelineId === null) {
        return null;
      }
      const payload = await daemonClient.checkoutForgeGetCheckDetails({
        cwd,
        checkRunId: pipelineId,
      });
      if (!payload.success || !payload.details) {
        return null;
      }
      return payload.details.pipeline ?? null;
    },
    enabled: shouldFetch,
    staleTime: live ? 0 : Infinity,
    refetchInterval: live && shouldFetch ? LIVE_PIPELINE_REFETCH_MS : false,
    refetchOnMount: true,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
    placeholderData: keepPreviousData,
  });

  return {
    pipeline: query.data ?? null,
    isLoading: shouldFetch && query.isLoading,
    isFetching: query.isFetching,
    error: query.error,
  };
}
