import { useCallback } from "react";
import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { KanbanPlan, KanbanSummary } from "@getpaseo/protocol/kanban/types";
import { useToast } from "@/contexts/toast-context";
import { kanbanQueryKey, kanbansQueryBaseKey } from "@/kanban/aggregated-kanbans";
import { findPlanTrackingWorkspace } from "@/kanban/workspace-plan-lookup";
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

interface AddWorkspaceToKanbanResult {
  plan: KanbanPlan;
  kanbanId: string;
  /** True when the workspace was already tracked by a plan — no new plan was created. */
  alreadyTracked: boolean;
}

function invalidateKanbanCaches(
  queryClient: QueryClient,
  input: { serverId: string; kanbanId: string },
): void {
  void queryClient.invalidateQueries({ queryKey: kanbansQueryBaseKey });
  void queryClient.invalidateQueries({ queryKey: kanbanQueryKey(input.serverId, input.kanbanId) });
}

/**
 * Get-or-create a project's kanban and drop a single-step workflow Plan wrapping this
 * workspace into its first column — the "Add to Kanban" discovery seam
 * (docs/kanban-tasks-spec.md). A kanban is one-per-project in v1, so this
 * reuses whichever one the project already has instead of creating a second.
 *
 * Before creating a plan, it scans every non-archived plan on that kanban for a step that
 * already references this workspace (`kanban/workspace-plan-lookup.ts`)
 * — a second click on the same workspace reuses the existing plan instead of creating a duplicate.
 *
 * The step needs at least one agent spec up front; this picks the host's first available
 * provider as a placeholder — the trigger is `manual`, so nothing runs until the user configures
 * and starts the step from the Plan sheet.
 */
export function useAddWorkspaceToKanban() {
  const { t } = useTranslation();
  const toast = useToast();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: AddWorkspaceToKanbanInput): Promise<AddWorkspaceToKanbanResult> => {
      const client = getHostRuntimeStore().getClient(input.serverId);
      if (!client) {
        throw new Error(t("sidebar.workspace.toasts.hostDisconnected"));
      }

      const list = await client.kanbanList();
      if (list.error) throw new Error(list.error);
      let kanbanSummary = list.kanbans.find((candidate) => candidate.projectId === input.projectId);
      if (!kanbanSummary) {
        const created = await client.kanbanCreate({ projectId: input.projectId });
        if (created.error || !created.kanban) {
          throw new Error(created.error ?? t("sidebar.kanban.addToKanban.createFailed"));
        }
        kanbanSummary = created.kanban;
      }

      const detail = await client.kanbanGet(kanbanSummary.id);
      if (detail.error || !detail.kanban) {
        throw new Error(detail.error ?? t("sidebar.kanban.addToKanban.createFailed"));
      }
      const kanban = detail.kanban;

      const existingPlan = findPlanTrackingWorkspace(kanban, input.workspaceId);
      if (existingPlan) {
        return { plan: existingPlan, kanbanId: kanban.id, alreadyTracked: true };
      }

      const availableProviders = await client.listAvailableProviders();
      const provider = availableProviders.providers.find((entry) => entry.available)?.provider;
      if (!provider) {
        throw new Error(t("sidebar.kanban.addToKanban.noProvider"));
      }

      const planResult = await client.kanbanPlanCreate({
        kanbanId: kanban.id,
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
      return { plan: planResult.plan, kanbanId: kanban.id, alreadyTracked: false };
    },
    onSuccess: (result, input) => {
      invalidateKanbanCaches(queryClient, { serverId: input.serverId, kanbanId: result.kanbanId });
      toast.show(
        result.alreadyTracked
          ? t("sidebar.kanban.addToKanban.alreadyTracked")
          : t("sidebar.kanban.addToKanban.success"),
      );
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
  const queryClient = useQueryClient();

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
      invalidateKanbanCaches(queryClient, {
        serverId: input.serverId,
        kanbanId: created.kanban.id,
      });
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
