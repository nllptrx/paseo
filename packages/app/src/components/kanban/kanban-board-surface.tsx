import { useCallback, useMemo, useState, type ReactElement } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { StoredKanban } from "@getpaseo/protocol/kanban/types";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { useKanbanMutations } from "@/hooks/use-kanban-mutations";
import { toErrorMessage } from "@/utils/error-messages";
import { KanbanBoard } from "./kanban-board";
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
  const { movePlan } = useKanbanMutations({ serverId });
  const [openPlanId, setOpenPlanId] = useState<string | null>(null);
  const [createColumnId, setCreateColumnId] = useState<string | null>(null);

  const handleMovePlan = useCallback(
    (planId: string, columnId: string, index: number) => {
      void movePlan({ kanbanId, parentPlanId: null, planId, columnId, index, movedBy: "user" });
    },
    [kanbanId, movePlan],
  );

  const handleClosePlan = useCallback(() => setOpenPlanId(null), []);
  const handleCloseCreatePlan = useCallback(() => setCreateColumnId(null), []);

  const board = useMemo(() => {
    if (!detail) {
      return null;
    }
    return { columns: detail.columns, plans: detail.plans };
  }, [detail]);

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
        onMovePlan={handleMovePlan}
        onCreatePlan={setCreateColumnId}
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
      {createColumnId ? (
        <KanbanPlanFormSheet
          serverId={serverId}
          kanbanId={kanbanId}
          parentPlanId={null}
          columnId={createColumnId}
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
