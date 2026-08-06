import { useCallback, useMemo, type ReactElement } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { Plus } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import type { Column, KanbanPlan, NestedPlan } from "@getpaseo/protocol/kanban/types";
import type { DraggableRenderItemInfo } from "@/components/draggable-list.types";
import { DraggableList } from "@/components/draggable-list";
import { Button } from "@/components/ui/button";
import { KanbanCard } from "./kanban-card";

export interface KanbanColumnProps {
  serverId: string;
  column: Column;
  columns: Column[];
  plans: (KanbanPlan | NestedPlan)[];
  onOpenPlan: (planId: string) => void;
  onMovePlan: (planId: string, columnId: string, index: number) => void;
  onCreatePlan: (columnId: string) => void;
}

function keyExtractorPlan(plan: KanbanPlan | NestedPlan): string {
  return plan.id;
}

function KanbanColumnCardItem({
  serverId,
  plan,
  columns,
  columnId,
  onOpenPlan,
  onMovePlan,
}: {
  serverId: string;
  plan: KanbanPlan | NestedPlan;
  columns: Column[];
  columnId: string;
  onOpenPlan: (planId: string) => void;
  onMovePlan: (planId: string, columnId: string, index: number) => void;
}): ReactElement {
  const handlePress = useCallback(() => onOpenPlan(plan.id), [onOpenPlan, plan.id]);
  const handleMoveToColumn = useCallback(
    (targetColumnId: string) => onMovePlan(plan.id, targetColumnId, 0),
    [onMovePlan, plan.id],
  );

  return (
    <KanbanCard
      serverId={serverId}
      plan={plan}
      columns={columns}
      currentColumnId={columnId}
      onPress={handlePress}
      onMoveToColumn={handleMoveToColumn}
    />
  );
}

export function KanbanColumn({
  serverId,
  column,
  columns,
  plans,
  onOpenPlan,
  onMovePlan,
  onCreatePlan,
}: KanbanColumnProps): ReactElement {
  const { t } = useTranslation();

  const handleDragEnd = useCallback(
    (nextPlans: (KanbanPlan | NestedPlan)[]) => {
      const reorderedIndex = nextPlans.findIndex((plan, index) => plans[index]?.id !== plan.id);
      if (reorderedIndex === -1) {
        return;
      }
      const movedPlan = nextPlans[reorderedIndex];
      onMovePlan(movedPlan.id, column.id, reorderedIndex);
    },
    [column.id, onMovePlan, plans],
  );

  const handleCreatePlan = useCallback(() => onCreatePlan(column.id), [column.id, onCreatePlan]);

  const renderItem = useCallback(
    ({ item }: DraggableRenderItemInfo<KanbanPlan | NestedPlan>) => (
      <KanbanColumnCardItem
        serverId={serverId}
        plan={item}
        columns={columns}
        columnId={column.id}
        onOpenPlan={onOpenPlan}
        onMovePlan={onMovePlan}
      />
    ),
    [serverId, columns, column.id, onOpenPlan, onMovePlan],
  );

  const emptyComponent = useMemo(
    () => <Text style={styles.empty}>{t("kanban.column.empty")}</Text>,
    [t],
  );

  return (
    <View style={styles.column} testID={`kanban-column-${column.id}`}>
      <View style={styles.header}>
        <Text style={styles.title}>{column.name}</Text>
        <Text style={styles.count}>{plans.length}</Text>
      </View>
      <DraggableList
        data={plans}
        keyExtractor={keyExtractorPlan}
        onDragEnd={handleDragEnd}
        containerStyle={styles.list}
        contentContainerStyle={styles.listContent}
        scrollEnabled={false}
        renderItem={renderItem}
        ListEmptyComponent={emptyComponent}
      />
      <Button
        variant="ghost"
        size="sm"
        leftIcon={Plus}
        onPress={handleCreatePlan}
        testID={`kanban-column-add-${column.id}`}
      >
        {t("kanban.column.addPlan")}
      </Button>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  column: {
    width: 280,
    backgroundColor: theme.colors.surface0,
    borderRadius: theme.borderRadius.lg,
    padding: theme.spacing[2],
    gap: theme.spacing[2],
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing[2],
    paddingTop: theme.spacing[1],
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  count: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  list: {
    minHeight: 40,
  },
  listContent: {
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[1],
  },
  empty: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    textAlign: "center",
    paddingVertical: theme.spacing[4],
  },
}));
