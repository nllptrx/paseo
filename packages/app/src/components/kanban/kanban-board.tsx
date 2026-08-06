import { useMemo, useState, type ReactElement } from "react";
import { ScrollView, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { Column, KanbanPlan, NestedPlan } from "@getpaseo/protocol/kanban/types";
import { useIsCompactFormFactor } from "@/constants/layout";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { KanbanColumn } from "./kanban-column";

export interface KanbanBoardView {
  columns: Column[];
  plans: Record<string, KanbanPlan | NestedPlan>;
}

export interface KanbanBoardProps {
  serverId: string;
  board: KanbanBoardView;
  onOpenPlan: (planId: string) => void;
  onMovePlan: (planId: string, columnId: string, index: number) => void;
  onCreatePlan: (columnId: string) => void;
}

/**
 * Renders the columns/cards for one kanban level. Reused as-is by the
 * Kanbans view, the Orchestrator board pane, and nested-kanban drill-ins —
 * all three only differ in what `board` and the callbacks resolve to.
 */
export function KanbanBoard({
  serverId,
  board,
  onOpenPlan,
  onMovePlan,
  onCreatePlan,
}: KanbanBoardProps): ReactElement {
  const isCompact = useIsCompactFormFactor();
  const [selectedColumnId, setSelectedColumnId] = useState<string | null>(
    board.columns[0]?.id ?? null,
  );

  const plansByColumn = useMemo(() => {
    const map = new Map<string, (KanbanPlan | NestedPlan)[]>();
    for (const column of board.columns) {
      map.set(
        column.id,
        column.planIds
          .map((planId) => board.plans[planId])
          .filter((plan): plan is KanbanPlan | NestedPlan => Boolean(plan)),
      );
    }
    return map;
  }, [board.columns, board.plans]);

  if (isCompact) {
    const activeColumnId = selectedColumnId ?? board.columns[0]?.id ?? null;
    const activeColumn = board.columns.find((column) => column.id === activeColumnId);
    return (
      <View style={styles.compactContainer}>
        <SegmentedControl
          size="sm"
          value={activeColumnId ?? ""}
          onValueChange={setSelectedColumnId}
          options={board.columns.map((column) => ({ value: column.id, label: column.name }))}
          testID="kanban-board-column-picker"
        />
        {activeColumn ? (
          <KanbanColumn
            serverId={serverId}
            column={activeColumn}
            columns={board.columns}
            plans={plansByColumn.get(activeColumn.id) ?? []}
            onOpenPlan={onOpenPlan}
            onMovePlan={onMovePlan}
            onCreatePlan={onCreatePlan}
          />
        ) : null}
      </View>
    );
  }

  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.wideScroll}>
      <View style={styles.wideRow}>
        {board.columns.map((column) => (
          <KanbanColumn
            key={column.id}
            serverId={serverId}
            column={column}
            columns={board.columns}
            plans={plansByColumn.get(column.id) ?? []}
            onOpenPlan={onOpenPlan}
            onMovePlan={onMovePlan}
            onCreatePlan={onCreatePlan}
          />
        ))}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create((theme) => ({
  // No `flex`/height here on purpose: the board sits inside the screen's own
  // vertical ScrollView, so it sizes to its tallest column and the page
  // scrolls, rather than nesting a second scroll viewport inside the first.
  wideScroll: {},
  wideRow: {
    flexDirection: "row",
    gap: theme.spacing[3],
    padding: theme.spacing[3],
    alignItems: "flex-start",
  },
  compactContainer: {
    gap: theme.spacing[3],
    padding: theme.spacing[3],
  },
}));
