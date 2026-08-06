import { useCallback } from "react";
import { useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { KanbanPlan, KanbanSummary } from "@getpaseo/protocol/kanban/types";
import { useToast } from "@/contexts/toast-context";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { useHostFeature } from "@/runtime/host-features";
import { toErrorMessage } from "@/utils/error-messages";

export interface AddWorkspaceToKanbanInput {
  serverId: string;
  projectId: string;
  workspaceId: string;
  /** Seeds the plan title and the one manual step's prompt. */
  title: string;
}

/**
 * Get-or-create a project's kanban and drop a single-step workflow Plan wrapping this
 * workspace into its first column — the "Add to Kanban" discovery seam
 * (`docs/kanban-workflow-stacking-plan.md` §4). A kanban is one-per-project in v1, so this
 * reuses whichever one the project already has instead of creating a second.
 *
 * The step needs at least one agent spec up front; this picks the host's first available
 * provider as a placeholder — the trigger is `manual`, so nothing runs until the user configures
 * and starts the step from the Plan sheet.
 */
export function useAddWorkspaceToKanban() {
  const { t } = useTranslation();
  const toast = useToast();

  return useMutation({
    mutationFn: async (input: AddWorkspaceToKanbanInput): Promise<KanbanPlan> => {
      const client = getHostRuntimeStore().getClient(input.serverId);
      if (!client) {
        throw new Error(t("sidebar.workspace.toasts.hostDisconnected"));
      }

      const list = await client.kanbanList();
      if (list.error) throw new Error(list.error);
      let kanban = list.kanbans.find((candidate) => candidate.projectId === input.projectId);
      if (!kanban) {
        const created = await client.kanbanCreate({ projectId: input.projectId });
        if (created.error || !created.kanban) {
          throw new Error(created.error ?? t("sidebar.kanban.addToKanban.createFailed"));
        }
        kanban = created.kanban;
      }

      const targetColumn =
        kanban.columns.find((column) => column.role === "backlog") ?? kanban.columns[0];
      if (!targetColumn) {
        throw new Error(t("sidebar.kanban.addToKanban.noColumns"));
      }

      const availableProviders = await client.listAvailableProviders();
      const provider = availableProviders.providers.find((entry) => entry.available)?.provider;
      if (!provider) {
        throw new Error(t("sidebar.kanban.addToKanban.noProvider"));
      }

      const planResult = await client.kanbanPlanCreate({
        kanbanId: kanban.id,
        columnId: targetColumn.id,
        title: input.title,
        body: {
          type: "workflow",
          steps: [
            {
              name: input.title,
              prompt: input.title,
              agents: [{ provider }],
              completion: "all",
              workspace: { mode: "existing", workspaceId: input.workspaceId },
              trigger: { type: "manual" },
            },
          ],
        },
      });
      if (planResult.error || !planResult.plan) {
        throw new Error(planResult.error ?? t("sidebar.kanban.addToKanban.createFailed"));
      }
      return planResult.plan;
    },
    onSuccess: () => {
      toast.show(t("sidebar.kanban.addToKanban.success"));
    },
    onError: (error) => {
      toast.error(toErrorMessage(error));
    },
  });
}

/**
 * The "Add to Kanban" workspace-row/project-header action, ready to hand to a menu item —
 * `undefined` when the host doesn't have the feature or the workspace hasn't hydrated a
 * `projectId` yet, which hides the action instead of letting it fail on press.
 */
export function useSidebarAddToKanbanAction(workspace: {
  serverId: string;
  projectId?: string;
  workspaceId: string;
  title: string;
}): (() => void) | undefined {
  const hasKanbanFeature = useHostFeature(workspace.serverId, "kanban");
  const addToKanban = useAddWorkspaceToKanban();
  const { serverId, projectId, workspaceId, title } = workspace;

  const handleAddToKanban = useCallback(() => {
    if (!projectId) return;
    addToKanban.mutate({ serverId, projectId, workspaceId, title });
  }, [addToKanban, projectId, serverId, title, workspaceId]);

  if (!hasKanbanFeature || !projectId) return undefined;
  return handleAddToKanban;
}

/**
 * The project header menu's "Add to Kanban" — get-or-create the project's kanban with no
 * specific workspace to wrap (a project header has no single workspace target, unlike a
 * workspace row). Wrapping a workspace stays the row-level action.
 */
export function useGetOrCreateProjectKanban() {
  const { t } = useTranslation();
  const toast = useToast();

  return useMutation({
    mutationFn: async (input: { serverId: string; projectId: string }): Promise<KanbanSummary> => {
      const client = getHostRuntimeStore().getClient(input.serverId);
      if (!client) {
        throw new Error(t("sidebar.workspace.toasts.hostDisconnected"));
      }
      const list = await client.kanbanList();
      if (list.error) throw new Error(list.error);
      const existing = list.kanbans.find((candidate) => candidate.projectId === input.projectId);
      if (existing) return existing;

      const created = await client.kanbanCreate({ projectId: input.projectId });
      if (created.error || !created.kanban) {
        throw new Error(created.error ?? t("sidebar.kanban.addToKanban.createFailed"));
      }
      return created.kanban;
    },
    onSuccess: () => {
      toast.show(t("sidebar.kanban.addToKanban.success"));
    },
    onError: (error) => {
      toast.error(toErrorMessage(error));
    },
  });
}
