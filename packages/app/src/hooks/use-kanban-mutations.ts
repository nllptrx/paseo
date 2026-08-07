import { useCallback } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type {
  CreateKanbanOptions,
  CreateKanbanPlanOptions,
  DaemonClient,
  KanbanPlanIdentifier,
  KanbanStepActionOptions,
  UpdateKanbanOptions,
  UpdateKanbanPlanOptions,
} from "@getpaseo/client/internal/daemon-client";
import type { OrchestratorPeer } from "@getpaseo/protocol/kanban/rpc-schemas";
import { kanbanQueryKey, kanbansQueryBaseKey } from "@/kanban/aggregated-kanbans";
import { orchestratorPeersQueryBaseKey } from "@/kanban/orchestrator-peers";
import { useSessionStore } from "@/stores/session-store";

export type CreateKanbanInput = Omit<CreateKanbanOptions, "requestId">;
export type UpdateKanbanInput = Omit<UpdateKanbanOptions, "requestId">;
export type CreateKanbanPlanInput = Omit<CreateKanbanPlanOptions, "requestId">;
export type UpdateKanbanPlanInput = Omit<UpdateKanbanPlanOptions, "requestId">;
export type KanbanPlanInput = Omit<KanbanPlanIdentifier, "requestId">;
export type KanbanStepInput = Omit<KanbanStepActionOptions, "requestId">;

export interface UseKanbanMutationsResult {
  createKanban: (input: CreateKanbanInput) => Promise<void>;
  updateKanban: (input: UpdateKanbanInput) => Promise<void>;
  archiveKanban: (kanbanId: string) => Promise<void>;
  createPlan: (input: CreateKanbanPlanInput) => Promise<void>;
  updatePlan: (input: UpdateKanbanPlanInput) => Promise<void>;
  archivePlan: (input: KanbanPlanInput) => Promise<void>;
  runStep: (input: KanbanStepInput) => Promise<void>;
  retryStep: (input: KanbanStepInput) => Promise<void>;
  skipStep: (input: KanbanStepInput) => Promise<void>;
  cancelStep: (input: KanbanStepInput) => Promise<void>;
  provisionOrchestrator: (kanbanId: string) => Promise<void>;
  unlinkOrchestrator: (kanbanId: string) => Promise<void>;
  listOrchestratorPeers: () => Promise<OrchestratorPeer[]>;
  isCreatingKanban: boolean;
  isUpdatingKanban: boolean;
  isArchivingKanban: boolean;
  isCreatingPlan: boolean;
  isUpdatingPlan: boolean;
  isArchivingPlan: boolean;
  isRunningStep: boolean;
  isRetryingStep: boolean;
  isSkippingStep: boolean;
  isCancelingStep: boolean;
  isProvisioningOrchestrator: boolean;
  isUnlinkingOrchestrator: boolean;
}

function requireClient(serverId: string, unavailableMessage: string): DaemonClient {
  const client = useSessionStore.getState().sessions[serverId]?.client ?? null;
  if (!client) {
    throw new Error(unavailableMessage);
  }
  return client;
}

export function useKanbanMutations({ serverId }: { serverId: string }): UseKanbanMutationsResult {
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  const invalidateList = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: kanbansQueryBaseKey });
  }, [queryClient]);

  const invalidateKanban = useCallback(
    (kanbanId: string) => {
      void queryClient.invalidateQueries({ queryKey: kanbanQueryKey(serverId, kanbanId) });
    },
    [queryClient, serverId],
  );

  const invalidateBoth = useCallback(
    (kanbanId: string) => {
      invalidateList();
      invalidateKanban(kanbanId);
    },
    [invalidateList, invalidateKanban],
  );

  /** Orchestrators are derived from agent labels and have no push channel, so a
   * surface listing them only learns about one it just asked for from here. */
  const invalidateOrchestrators = useCallback(
    (kanbanId: string) => {
      invalidateBoth(kanbanId);
      void queryClient.invalidateQueries({ queryKey: orchestratorPeersQueryBaseKey });
    },
    [invalidateBoth, queryClient],
  );

  const createKanbanMutation = useMutation({
    mutationFn: async (input: CreateKanbanInput): Promise<void> => {
      const client = requireClient(serverId, t("common.errors.daemonClientUnavailable"));
      const payload = await client.kanbanCreate(input);
      if (payload.error) {
        throw new Error(payload.error);
      }
    },
    onSettled: invalidateList,
  });

  const updateKanbanMutation = useMutation({
    mutationFn: async (input: UpdateKanbanInput): Promise<void> => {
      const client = requireClient(serverId, t("common.errors.daemonClientUnavailable"));
      const payload = await client.kanbanUpdate(input);
      if (payload.error) {
        throw new Error(payload.error);
      }
    },
    onSettled: (_data, _error, input) => invalidateBoth(input.kanbanId),
  });

  const archiveKanbanMutation = useMutation({
    mutationFn: async (kanbanId: string): Promise<void> => {
      const client = requireClient(serverId, t("common.errors.daemonClientUnavailable"));
      const payload = await client.kanbanArchive({ kanbanId });
      if (payload.error) {
        throw new Error(payload.error);
      }
    },
    onSettled: (_data, _error, kanbanId) => invalidateBoth(kanbanId),
  });

  const createPlanMutation = useMutation({
    mutationFn: async (input: CreateKanbanPlanInput): Promise<void> => {
      const client = requireClient(serverId, t("common.errors.daemonClientUnavailable"));
      const payload = await client.kanbanPlanCreate(input);
      if (payload.error) {
        throw new Error(payload.error);
      }
    },
    onSettled: (_data, _error, input) => invalidateBoth(input.kanbanId),
  });

  const updatePlanMutation = useMutation({
    mutationFn: async (input: UpdateKanbanPlanInput): Promise<void> => {
      const client = requireClient(serverId, t("common.errors.daemonClientUnavailable"));
      const payload = await client.kanbanPlanUpdate(input);
      if (payload.error) {
        throw new Error(payload.error);
      }
    },
    onSettled: (_data, _error, input) => invalidateKanban(input.kanbanId),
  });

  const archivePlanMutation = useMutation({
    mutationFn: async (input: KanbanPlanInput): Promise<void> => {
      const client = requireClient(serverId, t("common.errors.daemonClientUnavailable"));
      const payload = await client.kanbanPlanArchive(input);
      if (payload.error) {
        throw new Error(payload.error);
      }
    },
    onSettled: (_data, _error, input) => invalidateBoth(input.kanbanId),
  });

  const runStepMutation = useMutation({
    mutationFn: async (input: KanbanStepInput): Promise<void> => {
      const client = requireClient(serverId, t("common.errors.daemonClientUnavailable"));
      const payload = await client.kanbanStepRun(input);
      if (payload.error) {
        throw new Error(payload.error);
      }
    },
    onSettled: (_data, _error, input) => invalidateKanban(input.kanbanId),
  });

  const retryStepMutation = useMutation({
    mutationFn: async (input: KanbanStepInput): Promise<void> => {
      const client = requireClient(serverId, t("common.errors.daemonClientUnavailable"));
      const payload = await client.kanbanStepRetry(input);
      if (payload.error) {
        throw new Error(payload.error);
      }
    },
    onSettled: (_data, _error, input) => invalidateKanban(input.kanbanId),
  });

  const skipStepMutation = useMutation({
    mutationFn: async (input: KanbanStepInput): Promise<void> => {
      const client = requireClient(serverId, t("common.errors.daemonClientUnavailable"));
      const payload = await client.kanbanStepSkip(input);
      if (payload.error) {
        throw new Error(payload.error);
      }
    },
    onSettled: (_data, _error, input) => invalidateKanban(input.kanbanId),
  });

  const cancelStepMutation = useMutation({
    mutationFn: async (input: KanbanStepInput): Promise<void> => {
      const client = requireClient(serverId, t("common.errors.daemonClientUnavailable"));
      const payload = await client.kanbanStepCancel(input);
      if (payload.error) {
        throw new Error(payload.error);
      }
    },
    onSettled: (_data, _error, input) => invalidateKanban(input.kanbanId),
  });

  const provisionOrchestratorMutation = useMutation({
    mutationFn: async (kanbanId: string): Promise<void> => {
      const client = requireClient(serverId, t("common.errors.daemonClientUnavailable"));
      const payload = await client.kanbanOrchestratorProvision({ kanbanId });
      if (payload.error) {
        throw new Error(payload.error);
      }
    },
    onSettled: (_data, _error, kanbanId) => invalidateOrchestrators(kanbanId),
  });

  const unlinkOrchestratorMutation = useMutation({
    mutationFn: async (kanbanId: string): Promise<void> => {
      const client = requireClient(serverId, t("common.errors.daemonClientUnavailable"));
      const payload = await client.kanbanOrchestratorUnlink({ kanbanId });
      if (payload.error) {
        throw new Error(payload.error);
      }
    },
    onSettled: (_data, _error, kanbanId) => invalidateOrchestrators(kanbanId),
  });

  const listOrchestratorPeers = useCallback(async (): Promise<OrchestratorPeer[]> => {
    const client = requireClient(serverId, t("common.errors.daemonClientUnavailable"));
    const payload = await client.kanbanOrchestratorListPeers();
    if (payload.error) {
      throw new Error(payload.error);
    }
    return payload.peers;
  }, [serverId, t]);

  return {
    createKanban: (input) => createKanbanMutation.mutateAsync(input),
    updateKanban: (input) => updateKanbanMutation.mutateAsync(input),
    archiveKanban: (kanbanId) => archiveKanbanMutation.mutateAsync(kanbanId),
    createPlan: (input) => createPlanMutation.mutateAsync(input),
    updatePlan: (input) => updatePlanMutation.mutateAsync(input),
    archivePlan: (input) => archivePlanMutation.mutateAsync(input),
    runStep: (input) => runStepMutation.mutateAsync(input),
    retryStep: (input) => retryStepMutation.mutateAsync(input),
    skipStep: (input) => skipStepMutation.mutateAsync(input),
    cancelStep: (input) => cancelStepMutation.mutateAsync(input),
    provisionOrchestrator: (kanbanId) => provisionOrchestratorMutation.mutateAsync(kanbanId),
    unlinkOrchestrator: (kanbanId) => unlinkOrchestratorMutation.mutateAsync(kanbanId),
    listOrchestratorPeers,
    isCreatingKanban: createKanbanMutation.isPending,
    isUpdatingKanban: updateKanbanMutation.isPending,
    isArchivingKanban: archiveKanbanMutation.isPending,
    isCreatingPlan: createPlanMutation.isPending,
    isUpdatingPlan: updatePlanMutation.isPending,
    isArchivingPlan: archivePlanMutation.isPending,
    isRunningStep: runStepMutation.isPending,
    isRetryingStep: retryStepMutation.isPending,
    isSkippingStep: skipStepMutation.isPending,
    isCancelingStep: cancelStepMutation.isPending,
    isProvisioningOrchestrator: provisionOrchestratorMutation.isPending,
    isUnlinkingOrchestrator: unlinkOrchestratorMutation.isPending,
  };
}
