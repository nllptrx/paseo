import { useCallback } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { TaskProject } from "@getpaseo/protocol/tasks/types";
import { useToast } from "@/contexts/toast-context";
import { useHostFeature } from "@/runtime/host-features";
import { useProjectDisplayName } from "@/stores/session-store-hooks";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { suggestTaskProjectPrefix } from "@/tasks/new-task-form-model";
import { DEFAULT_TASK_PROJECT_COLOR } from "@/tasks/task-project-color";
import { tasksQueryKey } from "@/tasks/task-query-keys";
import { toErrorMessage } from "@/utils/error-messages";

interface EnsureBoardInput {
  serverId: string;
  /** The Paseo project whose checkout the board tracks. */
  projectId: string;
  projectName: string;
}

/**
 * The board for a Paseo project, created on first ask. A board is a tracker
 * project, so "this project has no board yet" and "this project has no tracker
 * project yet" are the same sentence — one call answers both.
 */
export function useEnsureProjectBoard() {
  const { t } = useTranslation();
  const toast = useToast();
  const queryClient = useQueryClient();
  const runtime = getHostRuntimeStore();

  return useMutation({
    mutationFn: async (input: EnsureBoardInput): Promise<TaskProject> => {
      const client = runtime.getClient(input.serverId);
      if (!client) {
        throw new Error(t("common.errors.daemonClientUnavailable"));
      }
      const snapshot = await client.tasksSnapshot();
      if (snapshot.error || !snapshot.snapshot) {
        throw new Error(snapshot.error ?? "The host returned no tracker snapshot");
      }
      const existing = snapshot.snapshot.projects.find(
        (project) => project.paseoProjectId === input.projectId,
      );
      if (existing) {
        return existing;
      }
      const created = await client.tasksProjectCreate({
        name: input.projectName,
        prefix: suggestTaskProjectPrefix(input.projectName) || "TSK",
        color: DEFAULT_TASK_PROJECT_COLOR,
        paseoProjectId: input.projectId,
      });
      if (created.error || !created.project) {
        throw new Error(created.error ?? "The host created no board");
      }
      return created.project;
    },
    onError: (error) => {
      toast.show(toErrorMessage(error));
    },
    onSettled: (_data, _error, input) => {
      void queryClient.invalidateQueries({ queryKey: tasksQueryKey(input.serverId) });
    },
  });
}

/**
 * The workspace row's "Add to board": put this workspace's work on the board as
 * a task. It captures rather than attaches — an agent lands on the card through
 * the card's own menu, which is also where a second one would.
 */
export function useSidebarAddToBoardAction(workspace: {
  serverId: string;
  projectId?: string;
  title: string;
}): (() => void) | undefined {
  const toast = useToast();
  const queryClient = useQueryClient();
  const runtime = getHostRuntimeStore();
  const hasTasks = useHostFeature(workspace.serverId, "tasks");
  const ensureBoard = useEnsureProjectBoard();
  const { serverId, projectId, title } = workspace;
  const projectName = useProjectDisplayName(serverId, projectId ?? "") ?? title;

  const handleAdd = useCallback(() => {
    if (!projectId) {
      return;
    }
    void (async () => {
      // The mutation reports its own failures, so this waits on it outside the
      // catch below rather than toasting the same error a second time.
      const project = await ensureBoard
        .mutateAsync({ serverId, projectId, projectName })
        .catch(() => null);
      if (!project) {
        return;
      }
      try {
        const client = runtime.getClient(serverId);
        if (!client) {
          throw new Error("Host disconnected");
        }
        const created = await client.tasksCreate({ projectId: project.id, title });
        if (created.error) {
          throw new Error(created.error);
        }
        void queryClient.invalidateQueries({ queryKey: tasksQueryKey(serverId) });
      } catch (error) {
        toast.show(toErrorMessage(error));
      }
    })();
  }, [ensureBoard, projectId, projectName, queryClient, runtime, serverId, title, toast]);

  if (!hasTasks || !projectId) {
    return undefined;
  }
  return handleAdd;
}
