import { useCallback, useMemo, useState, type CSSProperties, type ReactElement } from "react";
import { ScrollView, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { Plus } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  closestCenter,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Column, KanbanPlan, NestedPlan } from "@getpaseo/protocol/kanban/types";
import { useIsCompactFormFactor } from "@/constants/layout";
import { getDragActivationConstraints } from "@/components/drag-reorder";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { resolveBoardPlanDrop } from "@/kanban/apply-plan-move";
import { KanbanCard } from "./kanban-card";
import { KanbanColumn } from "./kanban-column";
import type { KanbanBoardProps, KanbanBoardView } from "./kanban-board";

export type { KanbanBoardProps, KanbanBoardView };

const COLUMN_DROP_PREFIX = "column:";
const DRAG_ACTIVATION_CONFIG = {
  movementDistance: 6,
  touchHoldDelayMs: 180,
  touchHoldTolerance: 8,
};

function columnDroppableId(columnId: string): string {
  return `${COLUMN_DROP_PREFIX}${columnId}`;
}

/**
 * The column under the pointer decides first, then the cards inside it. Running
 * closestCenter over every card at once would let a card in a crowded column win
 * over the empty column the pointer is actually on, so a drop there never lands.
 */
const boardCollisionDetection: CollisionDetection = (args) => {
  const columnRects = new Map(
    [...args.droppableRects.entries()].filter(
      ([id]) => typeof id === "string" && id.startsWith(COLUMN_DROP_PREFIX),
    ),
  );
  const columnArgs = { ...args, droppableRects: columnRects };
  const columnHits = pointerWithin(columnArgs);
  const resolvedColumnHits = columnHits.length > 0 ? columnHits : closestCenter(columnArgs);
  const targetColumnId = resolvedColumnHits[0]?.data?.droppableContainer?.data.current?.columnId;
  if (typeof targetColumnId !== "string") {
    return resolvedColumnHits;
  }

  const sortableRects = new Map(
    args.droppableContainers
      .filter(
        (container) =>
          container.id !== args.active.id &&
          container.data.current?.kind === "plan" &&
          container.data.current?.columnId === targetColumnId,
      )
      .flatMap((container) => {
        const rect = args.droppableRects.get(container.id);
        return rect ? [[container.id, rect] as const] : [];
      }),
  );
  if (sortableRects.size === 0) {
    return resolvedColumnHits;
  }
  return closestCenter({ ...args, droppableRects: sortableRects });
};

const COLUMN_BODY_STYLE: CSSProperties = {
  minHeight: 40,
  display: "flex",
  flexDirection: "column",
  gap: 8,
};
const OVERLAY_CARD_STYLE: CSSProperties = { width: 264, pointerEvents: "none" };
const noop = () => undefined;

function SortablePlanCard({
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
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: plan.id,
    data: { kind: "plan", columnId, planId: plan.id },
  });

  const style = useMemo<CSSProperties>(
    () => ({
      transform: CSS.Transform.toString(transform ? { ...transform, scaleX: 1, scaleY: 1 } : null),
      transition,
      opacity: isDragging ? 0.4 : 1,
    }),
    [isDragging, transform, transition],
  );

  const handlePress = useCallback(() => onOpenPlan(plan.id), [onOpenPlan, plan.id]);
  const handleMoveToColumn = useCallback(
    (targetColumnId: string) => onMovePlan(plan.id, targetColumnId, 0),
    [onMovePlan, plan.id],
  );

  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners}>
      <KanbanCard
        serverId={serverId}
        plan={plan}
        columns={columns}
        currentColumnId={columnId}
        onPress={handlePress}
        onMoveToColumn={handleMoveToColumn}
      />
    </div>
  );
}

function BoardColumn({
  serverId,
  column,
  columns,
  plans,
  onOpenPlan,
  onMovePlan,
  onCreatePlan,
}: {
  serverId: string;
  column: Column;
  columns: Column[];
  plans: (KanbanPlan | NestedPlan)[];
  onOpenPlan: (planId: string) => void;
  onMovePlan: (planId: string, columnId: string, index: number) => void;
  onCreatePlan: (columnId: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  const { setNodeRef, isOver } = useDroppable({
    id: columnDroppableId(column.id),
    data: { kind: "column", columnId: column.id },
  });
  const handleCreate = useCallback(() => onCreatePlan(column.id), [column.id, onCreatePlan]);

  return (
    <View
      style={[styles.column, isOver ? styles.columnOver : null]}
      testID={`kanban-column-${column.id}`}
    >
      <View style={styles.header}>
        <Text style={styles.title}>{column.name}</Text>
        <Text style={styles.count}>{plans.length}</Text>
      </View>
      <div ref={setNodeRef} style={COLUMN_BODY_STYLE}>
        <SortableContext
          items={plans.map((plan) => plan.id)}
          strategy={verticalListSortingStrategy}
        >
          {plans.map((plan) => (
            <SortablePlanCard
              key={plan.id}
              serverId={serverId}
              plan={plan}
              columns={columns}
              columnId={column.id}
              onOpenPlan={onOpenPlan}
              onMovePlan={onMovePlan}
            />
          ))}
        </SortableContext>
        {plans.length === 0 ? <Text style={styles.empty}>{t("kanban.column.empty")}</Text> : null}
      </div>
      <Button
        variant="ghost"
        size="sm"
        leftIcon={Plus}
        onPress={handleCreate}
        testID={`kanban-column-add-${column.id}`}
      >
        {t("kanban.column.addPlan")}
      </Button>
    </View>
  );
}

/**
 * Web board: wide layout uses one board-level DndContext so Plans can move
 * across columns. Compact keeps the segmented single-column + move menu path.
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
  const [activePlanId, setActivePlanId] = useState<string | null>(null);

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

  const activationConstraints = getDragActivationConstraints(false, DRAG_ACTIVATION_CONFIG);
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: activationConstraints.mouse }),
    useSensor(TouchSensor, { activationConstraint: activationConstraints.touch }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActivePlanId(String(event.active.id));
  }, []);

  const handleDragCancel = useCallback(() => {
    setActivePlanId(null);
  }, []);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setActivePlanId(null);
      const { active, over } = event;
      if (!over) {
        return;
      }
      const target = resolveBoardPlanDrop({
        columns: board.columns,
        planId: String(active.id),
        overId: String(over.id),
      });
      if (!target) {
        return;
      }
      onMovePlan(target.planId, target.columnId, target.index);
    },
    [board.columns, onMovePlan],
  );

  const activePlan = activePlanId ? (board.plans[activePlanId] ?? null) : null;
  const activeColumnIdForOverlay = useMemo(() => {
    if (!activePlan) {
      return board.columns[0]?.id ?? "";
    }
    return (
      board.columns.find((column) => column.planIds.includes(activePlan.id))?.id ??
      board.columns[0]?.id ??
      ""
    );
  }, [activePlan, board.columns]);

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
    <DndContext
      sensors={sensors}
      collisionDetection={boardCollisionDetection}
      onDragStart={handleDragStart}
      onDragCancel={handleDragCancel}
      onDragEnd={handleDragEnd}
    >
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.wideScroll}>
        <View style={styles.wideRow}>
          {board.columns.map((column) => (
            <BoardColumn
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
      <DragOverlay dropAnimation={null}>
        {activePlan ? (
          <div style={OVERLAY_CARD_STYLE}>
            <KanbanCard
              serverId={serverId}
              plan={activePlan}
              columns={board.columns}
              currentColumnId={activeColumnIdForOverlay}
              onPress={noop}
              onMoveToColumn={noop}
            />
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

const styles = StyleSheet.create((theme) => ({
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
  column: {
    width: 280,
    backgroundColor: theme.colors.surface0,
    borderRadius: theme.borderRadius.lg,
    padding: theme.spacing[2],
    gap: theme.spacing[2],
  },
  columnOver: {
    backgroundColor: theme.colors.surface1,
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
  empty: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    textAlign: "center",
    paddingVertical: theme.spacing[4],
  },
}));
