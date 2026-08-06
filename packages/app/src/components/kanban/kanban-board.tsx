import { useCallback, useMemo, useState, type ReactElement } from "react";
import { View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { KanbanPlan } from "@getpaseo/protocol/kanban/types";
import { useIsCompactFormFactor } from "@/constants/layout";
import { SegmentedControl } from "@/components/ui/segmented-control";
import {
  DERIVED_COLUMN_KEYS,
  type DerivedBoard,
  type DerivedColumnKey,
} from "@/kanban/derive-board";
import { KanbanColumn } from "./kanban-column";
import type { KanbanCardAction } from "./kanban-card";

const COLUMN_LABEL_KEYS: Record<DerivedColumnKey, string> = {
  draft: "kanban.column.draft",
  inProgress: "kanban.column.inProgress",
  done: "kanban.column.done",
};

export interface KanbanBoardProps {
  serverId: string;
  board: DerivedBoard;
  onOpenPlan: (planId: string) => void;
  onCreatePlan: () => void;
  planActions: (plan: KanbanPlan) => KanbanCardAction[];
  /** Dragging a draft onto the running column asks for it to run. Web only —
   * compact has no second column to drag onto, so it goes through the menu. */
  onRunPlan: (planId: string) => void;
  onReorderDrafts: (order: string[]) => void;
  /** A drop asked the board to contradict what actually ran. */
  onRejectedDrop: () => void;
}

/**
 * Columns and cards for one kanban, shared by the Kanbans view, the Orchestrator
 * board pane, and nested drill-ins. Dragging lives in the web board — on compact
 * there is no room for three columns side by side, so it segments instead.
 */
export function KanbanBoard({
  serverId,
  board,
  onOpenPlan,
  onCreatePlan,
  planActions,
}: KanbanBoardProps): ReactElement {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const [selectedColumn, setSelectedColumn] = useState<DerivedColumnKey>("draft");
  const [showAllDone, setShowAllDone] = useState(false);
  const handleShowAllDone = useCallback(() => setShowAllDone(true), []);

  const columnOptions = useMemo(
    () =>
      board.columns.map((column) => ({
        value: column.key,
        label: t(COLUMN_LABEL_KEYS[column.key]),
      })),
    [board.columns, t],
  );

  const handleSelectColumn = useCallback((value: string) => {
    if (DERIVED_COLUMN_KEYS.includes(value as DerivedColumnKey)) {
      setSelectedColumn(value as DerivedColumnKey);
    }
  }, []);

  if (isCompact) {
    const activeColumn = board.columns.find((column) => column.key === selectedColumn);
    return (
      <View style={styles.compactContainer}>
        <SegmentedControl
          size="sm"
          value={selectedColumn}
          onValueChange={handleSelectColumn}
          options={columnOptions}
          testID="kanban-board-column-picker"
        />
        {activeColumn ? (
          <KanbanColumn
            serverId={serverId}
            columnKey={activeColumn.key}
            plans={activeColumn.plans}
            onOpenPlan={onOpenPlan}
            planActions={planActions}
            showAllDone={showAllDone}
            onShowAllDone={handleShowAllDone}
            {...(activeColumn.key === "draft" ? { onCreatePlan } : {})}
          />
        ) : null}
      </View>
    );
  }

  return (
    <View style={styles.wideRow}>
      {board.columns.map((column) => (
        <KanbanColumn
          key={column.key}
          serverId={serverId}
          columnKey={column.key}
          plans={column.plans}
          onOpenPlan={onOpenPlan}
          planActions={planActions}
          showAllDone={showAllDone}
          onShowAllDone={handleShowAllDone}
          {...(column.key === "draft" ? { onCreatePlan } : {})}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  // No `flex`/height here on purpose: the board sits inside the screen's own
  // vertical ScrollView, so it sizes to its tallest column and the page
  // scrolls, rather than nesting a second scroll viewport inside the first.
  wideRow: {
    flexDirection: "row",
    gap: theme.spacing[3],
    padding: theme.spacing[3],
    alignItems: "stretch",
  },
  compactContainer: {
    gap: theme.spacing[3],
    padding: theme.spacing[3],
  },
}));
