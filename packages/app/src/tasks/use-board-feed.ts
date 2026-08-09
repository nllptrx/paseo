import { useCallback } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { TaskComment } from "@getpaseo/protocol/tasks/types";
import { useFetchQuery } from "@/data/query";
import { tasksPushRoute } from "@/data/push-router";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { boardFeedQueryKey } from "@/tasks/task-query-keys";
import { useTaskMessagesSupported, useTasksSupported } from "@/tasks/use-tasks";

export { boardFeedQueryBaseKey, boardFeedQueryKey } from "@/tasks/task-query-keys";

export interface UseBoardFeedResult {
  entries: TaskComment[];
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  refetch: () => void;
}

/**
 * A board's feed, oldest first. It shares the tracker's push route: every entry
 * is a tracker write, so the revision that lands after one is the same signal
 * the board itself refetches on.
 */
export function useBoardFeed(input: {
  serverId: string;
  projectId: string | null;
}): UseBoardFeedResult {
  const { serverId, projectId } = input;
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const supported = useTasksSupported(serverId);
  const enabled = Boolean(client && isConnected && supported && projectId);

  const query = useFetchQuery({
    queryKey: boardFeedQueryKey(serverId, projectId ?? ""),
    enabled,
    dataShape: "list",
    staleTimeMs: 2_000,
    meta: tasksPushRoute({ enabled, serverIds: [serverId] }),
    queryFn: async (): Promise<TaskComment[]> => {
      if (!client || !projectId) {
        throw new Error(t("common.errors.daemonClientUnavailable"));
      }
      const payload = await client.tasksFeedRead({ projectId });
      if (payload.error) {
        throw new Error(payload.error);
      }
      return payload.entries;
    },
  });

  return {
    entries: query.data ?? [],
    isLoading: enabled && query.isPending,
    isError: query.isError,
    error: query.error,
    refetch: () => {
      void query.refetch();
    },
  };
}

export interface UseBoardFeedComposerResult {
  post: (input: { body: string; taskId?: string | null }) => Promise<void>;
  sendMessage: (input: {
    body: string;
    taskId: string;
    recipientAgentIds: string[];
  }) => Promise<void>;
  isPosting: boolean;
}

export function useBoardFeedComposer(input: {
  serverId: string;
  projectId: string | null;
}): UseBoardFeedComposerResult {
  const { serverId, projectId } = input;
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const supportsMessages = useTaskMessagesSupported(serverId);
  const queryClient = useQueryClient();

  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: boardFeedQueryKey(serverId, projectId ?? ""),
    });
  }, [projectId, queryClient, serverId]);

  const mutation = useMutation({
    mutationFn: async (entry: { body: string; taskId?: string | null }) => {
      if (!client || !projectId) {
        throw new Error(t("common.errors.daemonClientUnavailable"));
      }
      if (!supportsMessages && entry.body.includes("@")) {
        throw new Error(t("tasks.feed.legacyNoteWarning"));
      }
      const payload = await client.tasksFeedPost({
        projectId,
        body: entry.body,
        ...(supportsMessages ? { entryKind: "note" as const } : {}),
        ...(entry.taskId !== undefined ? { taskId: entry.taskId } : {}),
      });
      if (payload.error) {
        throw new Error(payload.error);
      }
    },
    onSettled: invalidate,
  });

  const messageMutation = useMutation({
    mutationFn: async (message: { body: string; taskId: string; recipientAgentIds: string[] }) => {
      if (!client || !projectId) {
        throw new Error(t("common.errors.daemonClientUnavailable"));
      }
      const payload = await client.tasksFeedSendMessage({ projectId, ...message });
      if (payload.error) throw new Error(payload.error);
    },
    onSettled: invalidate,
  });

  return {
    post: async (entry) => {
      await mutation.mutateAsync(entry);
    },
    sendMessage: async (message) => {
      await messageMutation.mutateAsync(message);
    },
    isPosting: mutation.isPending || messageMutation.isPending,
  };
}
