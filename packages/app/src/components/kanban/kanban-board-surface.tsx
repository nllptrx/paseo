import { useCallback, useMemo, useState, type ReactElement } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { KanbanPlan, StoredKanban } from "@getpaseo/protocol/kanban/types";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { useToast } from "@/contexts/toast-context";
import { useKanbanMutations } from "@/hooks/use-kanban-mutations";
import { deriveBoard } from "@/kanban/derive-board";
import { resolveNextRunnableStepId } from "@/kanban/run-plan";
import { useKanbanDraftOrder, useKanbanDraftOrderStore } from "@/stores/kanban-draft-order-store";
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
  const [openPlanId, setOpenPlanId] = useState<string | null>(null);
  const [isCreatingPlan, setIsCreatingPlan] = useState(false);
  const draftOrder = useKanbanDraftOrder(kanbanId);
  const setDraftOrder = useKanbanDraftOrderStore((state) => state.setDraftOrder);

  const board = useMemo(
    () => (detail ? deriveBoard(detail, draftOrder) : null),
    [detail, draftOrder],
  );

  // Columns are derived from what ran, but the daemon still stores a column per
  // plan. New plans are always drafts, so they land in the stored backlog column
  // and nothing reads it back. Drops out when the store stops keeping columns.
  const backlogColumnId = useMemo(() => {
    if (!detail) {
      return null;
    }
    const backlog = detail.columns.find((column) => column.role === "backlog");
    return backlog?.id ?? detail.columns[0]?.id ?? null;
  }, [detail]);

  const handleRunPlan = useCallback(
    (planId: string) => {
      const plan = detail?.plans[planId];
      const stepId = plan ? resolveNextRunnableStepId(plan) : null;
      if (stepId === null) {
        return;
      }
      void runStep({ kanbanId, parentPlanId: null, planId, stepId });
    },
    [detail, kanbanId, runStep],
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
        label: t("common.actions.archive"),
        onSelect: () => {
          void archivePlan({ kanbanId, parentPlanId: null, planId: plan.id });
        },
      });
      return actions;
    },
    [archivePlan, handleRunPlan, kanbanId, t],
  );

  const handleClosePlan = useCallback(() => setOpenPlanId(null), []);
  const handleOpenCreatePlan = useCallback(() => setIsCreatingPlan(true), []);
  const handleCloseCreatePlan = useCallback(() => setIsCreatingPlan(false), []);

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
        onOpenPlan={setOpenPlanId}
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
      {isCreatingPlan && backlogColumnId ? (
        <KanbanPlanFormSheet
          serverId={serverId}
          kanbanId={kanbanId}
          parentPlanId={null}
          columnId={backlogColumnId}
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
