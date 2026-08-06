import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from "react";
import { View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  closestCorners,
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
import type { KanbanPlan } from "@getpaseo/protocol/kanban/types";
import { useIsCompactFormFactor } from "@/constants/layout";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { getDragActivationConstraints } from "@/components/drag-reorder";
import {
  DERIVED_COLUMN_KEYS,
  resolveBoardDrop,
  type BoardDropAction,
  type DerivedColumnKey,
} from "@/kanban/derive-board";
import { KanbanColumn } from "./kanban-column";
import { KanbanCard } from "./kanban-card";
import type { KanbanBoardProps } from "./kanban-board";

export type { KanbanBoardProps } from "./kanban-board";

const COLUMN_DROP_PREFIX = "column:";
const DRAG_ACTIVATION_CONFIG = {
  movementDistance: 6,
  touchHoldDelayMs: 180,
  touchHoldTolerance: 8,
};

const COLUMN_LABEL_KEYS: Record<DerivedColumnKey, string> = {
  draft: "kanban.column.draft",
  inProgress: "kanban.column.inProgress",
  done: "kanban.column.done",
};

function columnDropId(columnKey: DerivedColumnKey): string {
  return `${COLUMN_DROP_PREFIX}${columnKey}`;
}

function parseColumnDropId(dropId: string): DerivedColumnKey | null {
  if (!dropId.startsWith(COLUMN_DROP_PREFIX)) {
    return null;
  }
  const key = dropId.slice(COLUMN_DROP_PREFIX.length);
  return DERIVED_COLUMN_KEYS.includes(key as DerivedColumnKey) ? (key as DerivedColumnKey) : null;
}

/**
 * The pointer decides, and only falls back to proximity when it is over nothing.
 * Ranking every card and column together instead would let a card in a crowded
 * column outscore the empty column the pointer is actually on.
 */
const boardCollisionDetection: CollisionDetection = (args) => {
  const pointerCollisions = pointerWithin(args);
  return pointerCollisions.length > 0 ? pointerCollisions : closestCorners(args);
};

export function KanbanBoard({
  serverId,
  board,
  onOpenPlan,
  onCreatePlan,
  planActions,
  onRunPlan,
  onReorderDrafts,
  onRejectedDrop,
}: KanbanBoardProps): ReactElement {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const [selectedColumn, setSelectedColumn] = useState<DerivedColumnKey>("draft");
  const [showAllDone, setShowAllDone] = useState(false);
  const [activePlanId, setActivePlanId] = useState<string | null>(null);
  // A finished drag still emits a click on the source card; swallow exactly that
  // one so dropping a card never also opens it.
  const suppressClickRef = useRef(false);

  const handleShowAllDone = useCallback(() => setShowAllDone(true), []);
  const handleSelectColumn = useCallback((value: string) => {
    if (DERIVED_COLUMN_KEYS.includes(value as DerivedColumnKey)) {
      setSelectedColumn(value as DerivedColumnKey);
    }
  }, []);

  const activationConstraints = getDragActivationConstraints(false, DRAG_ACTIVATION_CONFIG);
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: activationConstraints.mouse }),
    useSensor(TouchSensor, { activationConstraint: activationConstraints.touch }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const draftPlanIds = useMemo(
    () => (board.columns.find((column) => column.key === "draft")?.plans ?? []).map((p) => p.id),
    [board.columns],
  );
  const activePlan = useMemo(() => {
    if (activePlanId === null) {
      return null;
    }
    for (const column of board.columns) {
      const found = column.plans.find((plan) => plan.id === activePlanId);
      if (found) {
        return found;
      }
    }
    return null;
  }, [activePlanId, board.columns]);

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActivePlanId(String(event.active.id));
    suppressClickRef.current = true;
  }, []);

  const releaseClickSuppression = useCallback(() => {
    // The trailing click fires synchronously after dragend; release on the next
    // tick so a plain click on a card still opens it.
    setTimeout(() => {
      suppressClickRef.current = false;
    }, 0);
  }, []);

  const handleDragCancel = useCallback(() => {
    setActivePlanId(null);
    releaseClickSuppression();
  }, [releaseClickSuppression]);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setActivePlanId(null);
      releaseClickSuppression();
      const { active, over } = event;
      if (!over) {
        return;
      }
      const overId = String(over.id);
      const overColumn = parseColumnDropId(overId);
      const targetColumn =
        overColumn ??
        board.columns.find((column) => column.plans.some((plan) => plan.id === overId))?.key ??
        null;
      if (targetColumn === null) {
        return;
      }

      const action: BoardDropAction = resolveBoardDrop({
        board,
        activePlanId: String(active.id),
        targetColumn,
        overPlanId: overColumn === null ? overId : null,
      });
      if (action.kind === "run") {
        onRunPlan(action.planId);
        return;
      }
      if (action.kind === "reorderDraft") {
        onReorderDrafts(action.order);
        return;
      }
      if (action.kind === "derived-column") {
        onRejectedDrop();
      }
    },
    [board, onRejectedDrop, onReorderDrafts, onRunPlan, releaseClickSuppression],
  );

  const handleOpenPlan = useCallback(
    (planId: string) => {
      if (suppressClickRef.current) {
        return;
      }
      onOpenPlan(planId);
    },
    [onOpenPlan],
  );

  const isDraggingDraft = activePlanId !== null && draftPlanIds.includes(activePlanId);

  if (isCompact) {
    const activeColumn = board.columns.find((column) => column.key === selectedColumn);
    return (
      <View style={styles.compactContainer}>
        <SegmentedControl
          size="sm"
          value={selectedColumn}
          onValueChange={handleSelectColumn}
          options={board.columns.map((column) => ({
            value: column.key,
            label: t(COLUMN_LABEL_KEYS[column.key]),
          }))}
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
    <DndContext
      sensors={sensors}
      collisionDetection={boardCollisionDetection}
      onDragStart={handleDragStart}
      onDragCancel={handleDragCancel}
      onDragEnd={handleDragEnd}
    >
      <View style={styles.wideRow}>
        {board.columns.map((column) => (
          <DroppableColumn
            key={column.key}
            serverId={serverId}
            columnKey={column.key}
            plans={column.plans}
            onOpenPlan={handleOpenPlan}
            planActions={planActions}
            showAllDone={showAllDone}
            onShowAllDone={handleShowAllDone}
            isRunTarget={isDraggingDraft && column.key === "inProgress"}
            sortable={column.key === "draft"}
            {...(column.key === "draft" ? { onCreatePlan } : {})}
          />
        ))}
      </View>
      <DragOverlay dropAnimation={null}>
        {activePlan ? (
          <KanbanCard serverId={serverId} plan={activePlan} onPress={noop} actions={[]} isOverlay />
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

const noop = () => undefined;

function DroppableColumn({
  serverId,
  columnKey,
  plans,
  onOpenPlan,
  planActions,
  onCreatePlan,
  showAllDone,
  onShowAllDone,
  isRunTarget,
  sortable,
}: {
  serverId: string;
  columnKey: DerivedColumnKey;
  plans: KanbanPlan[];
  onOpenPlan: (planId: string) => void;
  planActions: KanbanBoardProps["planActions"];
  onCreatePlan?: () => void;
  showAllDone: boolean;
  onShowAllDone: () => void;
  isRunTarget: boolean;
  sortable: boolean;
}): ReactElement {
  const { isOver, setNodeRef } = useDroppable({ id: columnDropId(columnKey) });
  const sortableIds = useMemo(() => plans.map((plan) => plan.id), [plans]);

  const renderCard = useCallback(
    (plan: KanbanPlan, card: ReactNode) =>
      sortable ? <SortablePlanCard planId={plan.id}>{card}</SortablePlanCard> : card,
    [sortable],
  );

  const column = (
    <KanbanColumn
      serverId={serverId}
      columnKey={columnKey}
      plans={plans}
      onOpenPlan={onOpenPlan}
      planActions={planActions}
      showAllDone={showAllDone}
      onShowAllDone={onShowAllDone}
      isRunTarget={isRunTarget}
      isOver={isOver}
      renderCard={renderCard}
      bodyRef={setNodeRef}
      {...(onCreatePlan ? { onCreatePlan } : {})}
    />
  );

  return sortable ? (
    <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
      {column}
    </SortableContext>
  ) : (
    column
  );
}

function SortablePlanCard({
  planId,
  children,
}: {
  planId: string;
  children: ReactNode;
}): ReactElement {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: planId,
  });
  const style = useMemo<CSSProperties>(
    () => ({
      transform: CSS.Translate.toString(transform),
      transition,
      opacity: isDragging ? 0.4 : 1,
    }),
    [isDragging, transform, transition],
  );
  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners}>
      {children}
    </div>
  );
}

const styles = StyleSheet.create((theme) => ({
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
