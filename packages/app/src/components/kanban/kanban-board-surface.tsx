import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { KanbanPlan, Step, StoredKanban } from "@getpaseo/protocol/kanban/types";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { useToast } from "@/contexts/toast-context";
import { useKanbanMutations } from "@/hooks/use-kanban-mutations";
import { useKeyboardActionHandler } from "@/hooks/use-keyboard-action-handler";
import {
  applyOptimisticDispatch,
  deriveBoard,
  retainPendingDispatches,
} from "@/kanban/derive-board";
import { resolveStepDispatchBlock } from "@/kanban/dispatch-guard";
import { resolvePlanOpenTarget } from "@/kanban/plan-open-target";
import { resolveNextRunnableStepId } from "@/kanban/run-plan";
import { resolveProviderLabel } from "@/kanban/step-detail";
import { useKanbanAvailableProviders } from "@/kanban/use-kanban-available-providers";
import type { KeyboardActionId } from "@/keyboard/keyboard-action-dispatcher";
import { useKanbanDraftOrder, useKanbanDraftOrderStore } from "@/stores/kanban-draft-order-store";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { toErrorMessage } from "@/utils/error-messages";
import { KanbanBoard } from "./kanban-board";
import type { KanbanCardAction } from "./kanban-card";
import { KanbanPlanFormSheet } from "./kanban-plan-form-sheet";
import { KanbanPlanSheet } from "./kanban-plan-sheet";

export interface KanbanBoardSurfaceProps {
  serverId: string;
  kanbanId: string;
  detail: StoredKanban | null;
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  onRetry: () => void;
}

const NEW_PLAN_ACTIONS: readonly KeyboardActionId[] = ["kanban.plan.new"];

function findStep(plan: KanbanPlan, stepId: string): Step | null {
  if (plan.body.type !== "workflow") {
    return null;
  }
  return plan.body.steps.find((step) => step.id === stepId) ?? null;
}

/**
 * One kanban's columns plus the plan sheets its cards open. Shared by the Kanbans
 * view and the Orchestrator pane so both steer the same daemon state through the
 * same callbacks.
 */
export function KanbanBoardSurface({
  serverId,
  kanbanId,
  detail,
  isLoading,
  isError,
  error,
  onRetry,
}: KanbanBoardSurfaceProps): ReactElement | null {
  const { t } = useTranslation();
  const toast = useToast();
  const { runStep, archivePlan } = useKanbanMutations({ serverId });
  const { providers } = useKanbanAvailableProviders(serverId);
  const [openPlanId, setOpenPlanId] = useState<string | null>(null);
  const [isCreatingPlan, setIsCreatingPlan] = useState(false);
  const [pendingDispatchIds, setPendingDispatchIds] = useState<string[]>([]);
  const draftOrder = useKanbanDraftOrder(kanbanId);
  const setDraftOrder = useKanbanDraftOrderStore((state) => state.setDraftOrder);

  const settledBoard = useMemo(
    () => (detail ? deriveBoard(detail, draftOrder) : null),
    [detail, draftOrder],
  );
  const board = useMemo(
    () => (settledBoard ? applyOptimisticDispatch(settledBoard, pendingDispatchIds) : null),
    [pendingDispatchIds, settledBoard],
  );

  // Reconciled against what the daemon holds, never against the overlay, so a
  // plan whose run has landed stops being pending and the two agree.
  useEffect(() => {
    if (!settledBoard || pendingDispatchIds.length === 0) {
      return;
    }
    const retained = retainPendingDispatches(settledBoard, pendingDispatchIds);
    if (retained.length !== pendingDispatchIds.length) {
      setPendingDispatchIds(retained);
    }
  }, [pendingDispatchIds, settledBoard]);

  const clearPendingDispatch = useCallback((planId: string) => {
    setPendingDispatchIds((current) => current.filter((entry) => entry !== planId));
  }, []);

  const handleRunPlan = useCallback(
    (planId: string) => {
      const plan = detail?.plans[planId];
      const stepId = plan ? resolveNextRunnableStepId(plan) : null;
      if (!plan || stepId === null) {
        return;
      }
      // A drag that started before the board re-derived can land twice; the
      // second drop must not queue another turn.
      if (pendingDispatchIds.includes(planId)) {
        return;
      }
      const step = findStep(plan, stepId);
      const block = step ? resolveStepDispatchBlock({ step, providers }) : null;
      if (block) {
        const provider = resolveProviderLabel(block.provider);
        toast.show(
          block.reason
            ? t("kanban.dispatch.providerUnavailableWithReason", {
                provider,
                reason: block.reason,
              })
            : t("kanban.dispatch.providerUnavailable", { provider }),
        );
        return;
      }
      setPendingDispatchIds((current) => [...current, planId]);
      void runStep({ kanbanId, parentPlanId: null, planId, stepId }).catch((dispatchError) => {
        clearPendingDispatch(planId);
        toast.show(toErrorMessage(dispatchError));
      });
    },
    [clearPendingDispatch, detail, kanbanId, pendingDispatchIds, providers, runStep, t, toast],
  );

  const handleReorderDrafts = useCallback(
    (order: string[]) => setDraftOrder(kanbanId, order),
    [kanbanId, setDraftOrder],
  );

  const handleRejectedDrop = useCallback(() => {
    toast.show(t("kanban.column.doneIsDerivedDescription"));
  }, [t, toast]);

  const planActions = useCallback(
    (plan: KanbanPlan): KanbanCardAction[] => {
      const actions: KanbanCardAction[] = [];
      if (resolveNextRunnableStepId(plan) !== null) {
        actions.push({
          key: "run",
          label: t("kanban.step.actions.run"),
          onSelect: () => handleRunPlan(plan.id),
        });
      }
      actions.push({
        key: "archive",
        label: t("kanban.card.archive"),
        onSelect: () => {
          void archivePlan({ kanbanId, parentPlanId: null, planId: plan.id });
        },
      });
      return actions;
    },
    [archivePlan, handleRunPlan, kanbanId, t],
  );

  /**
   * Work that is under way is a conversation, so the card opens it. Only a plan
   * with nothing running falls back to the step list.
   */
  const handleOpenPlan = useCallback(
    (planId: string) => {
      const plan = detail?.plans[planId];
      const target = plan ? resolvePlanOpenTarget(plan) : { kind: "plan" as const };
      if (target.kind === "agent") {
        navigateToWorkspace({
          serverId,
          workspaceId: target.workspaceId,
          target: { kind: "agent", agentId: target.agentId },
        });
        return;
      }
      setOpenPlanId(planId);
    },
    [detail, serverId],
  );

  const handleClosePlan = useCallback(() => setOpenPlanId(null), []);
  const handleOpenCreatePlan = useCallback(() => setIsCreatingPlan(true), []);
  const handleCloseCreatePlan = useCallback(() => setIsCreatingPlan(false), []);

  const handleNewPlanShortcut = useCallback(() => {
    setIsCreatingPlan(true);
    return true;
  }, []);

  useKeyboardActionHandler({
    handlerId: `kanban-plan-new-${kanbanId}`,
    actions: NEW_PLAN_ACTIONS,
    enabled: detail !== null && !isCreatingPlan,
    priority: 0,
    handle: handleNewPlanShortcut,
  });

  if (isLoading && !detail) {
    return (
      <View style={styles.centered}>
        <LoadingSpinner size="small" color={styles.spinner.color} />
      </View>
    );
  }

  if (isError && !detail) {
    return (
      <View style={styles.centered}>
        <Text style={styles.errorText}>{toErrorMessage(error)}</Text>
        <Button
          variant="ghost"
          size="sm"
          onPress={onRetry}
          testID={`kanban-board-retry-${kanbanId}`}
        >
          {t("common.actions.retry")}
        </Button>
      </View>
    );
  }

  if (!detail || !board) {
    return null;
  }

  return (
    <>
      <KanbanBoard
        serverId={serverId}
        board={board}
        onOpenPlan={handleOpenPlan}
        onCreatePlan={handleOpenCreatePlan}
        planActions={planActions}
        onRunPlan={handleRunPlan}
        onReorderDrafts={handleReorderDrafts}
        onRejectedDrop={handleRejectedDrop}
      />
      {openPlanId ? (
        <KanbanPlanSheet
          serverId={serverId}
          kanbanId={kanbanId}
          parentPlanId={null}
          planId={openPlanId}
          kanban={detail}
          visible
          onClose={handleClosePlan}
        />
      ) : null}
      {isCreatingPlan ? (
        <KanbanPlanFormSheet
          serverId={serverId}
          kanbanId={kanbanId}
          parentPlanId={null}
          visible
          onClose={handleCloseCreatePlan}
        />
      ) : null}
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  centered: {
    alignItems: "center",
    gap: theme.spacing[2],
    padding: theme.spacing[6],
  },
  errorText: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.sm,
  },
  spinner: {
    color: theme.colors.foregroundMuted,
  },
}));
