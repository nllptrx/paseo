import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
} from "react";
import { ScrollView, View } from "react-native";
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
import type { Task, TaskStatus } from "@getpaseo/protocol/tasks/types";
import { TASK_STATUSES } from "@getpaseo/protocol/tasks/types";
import { useIsCompactFormFactor } from "@/constants/layout";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { getDragActivationConstraints } from "@/components/drag-reorder";
import {
  projectBoardColumns,
  resolveTaskDropNeighbours,
  visibleBoardStatuses,
  type TaskBoardRow,
} from "@/tasks/task-views";
import {
  TASK_STATUS_LABEL_KEYS,
  TaskCard,
  TaskColumn,
  groupBoardTasks,
  useMoveToStatusEnd,
  type TaskBoardMove,
  type TaskBoardProps,
} from "./task-board-parts";

export {
  TASK_STATUS_LABEL_KEYS,
  type TaskBoardMove,
  type TaskBoardProps,
} from "./task-board-parts";

const COLUMN_DROP_PREFIX = "column:";
const DRAG_ACTIVATION_CONFIG = {
  movementDistance: 6,
  touchHoldDelayMs: 180,
  touchHoldTolerance: 8,
};

function columnDropId(status: TaskStatus): string {
  return `${COLUMN_DROP_PREFIX}${status}`;
}

function parseColumnDropId(dropId: string): TaskStatus | null {
  if (!dropId.startsWith(COLUMN_DROP_PREFIX)) {
    return null;
  }
  const status = dropId.slice(COLUMN_DROP_PREFIX.length);
  return TASK_STATUSES.includes(status as TaskStatus) ? (status as TaskStatus) : null;
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

/**
 * Where a drop landed: the destination column with the dragged task already
 * removed, and the slot index inside it. Dropping on a card takes that card's
 * slot; dropping on the column body appends.
 */
export function resolveTaskBoardDrop(input: {
  columnTasks: readonly Task[];
  activeTaskId: string;
  overTaskId: string | null;
}): { tasks: Task[]; index: number } {
  const tasks = input.columnTasks.filter((task) => task.id !== input.activeTaskId);
  if (input.overTaskId === null || input.overTaskId === input.activeTaskId) {
    return { tasks, index: tasks.length };
  }
  const overIndex = tasks.findIndex((task) => task.id === input.overTaskId);
  return { tasks, index: overIndex === -1 ? tasks.length : overIndex };
}

export function TaskBoard({
  serverId,
  tasks,
  labels,
  projectsById,
  executionByTaskId,
  relationshipsByTaskId,
  onMoveTask,
  onCreateTask,
  onOpenAgent,
  onOpenTask,
  onReviewTask,
  onStartReview,
  onDeleteTask,
  onCreateWorkflowForTask,
  selectedColumn,
  onSelectColumn,
  expandSubtasks,
  dragDisabled = false,
}: TaskBoardProps): ReactElement {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  // A finished drag still emits a click on the source card; swallow exactly that
  // one so dropping a card never also triggers its press.
  const suppressClickRef = useRef(false);

  const statuses = useMemo(() => visibleBoardStatuses(tasks), [tasks]);
  // A drop is resolved against the stored statuses, never the projection: a
  // subtask drawn under its parent sits in a column it is not stored in, and a
  // position read there would mean nothing.
  const byStatus = useMemo(() => groupBoardTasks(statuses, tasks), [statuses, tasks]);
  const rowsByStatus = useMemo(
    () => projectBoardColumns({ statuses, tasks, expandSubtasks }),
    [expandSubtasks, statuses, tasks],
  );
  const handleMoveToStatus = useMoveToStatusEnd(byStatus, onMoveTask);

  const activationConstraints = getDragActivationConstraints(false, DRAG_ACTIVATION_CONFIG);
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: activationConstraints.mouse }),
    useSensor(TouchSensor, { activationConstraint: activationConstraints.touch }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const activeTask = useMemo(
    () => (activeTaskId === null ? null : (tasks.find((task) => task.id === activeTaskId) ?? null)),
    [activeTaskId, tasks],
  );

  const handleSelectColumn = useCallback(
    (value: string) => {
      const status = TASK_STATUSES.find((entry) => entry === value);
      if (status) {
        onSelectColumn(status);
      }
    },
    [onSelectColumn],
  );

  const handleOpenAgent = useCallback(
    (input: { workspaceId: string; agentId: string }) => {
      if (suppressClickRef.current) {
        return;
      }
      onOpenAgent(input);
    },
    [onOpenAgent],
  );

  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      if (dragDisabled) return;
      setActiveTaskId(String(event.active.id));
      suppressClickRef.current = true;
    },
    [dragDisabled],
  );

  const releaseClickSuppression = useCallback(() => {
    setTimeout(() => {
      suppressClickRef.current = false;
    }, 0);
  }, []);

  const handleDragCancel = useCallback(() => {
    setActiveTaskId(null);
    releaseClickSuppression();
  }, [releaseClickSuppression]);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      if (dragDisabled) return;
      setActiveTaskId(null);
      releaseClickSuppression();
      const { active, over } = event;
      if (!over) {
        return;
      }
      const activeId = String(active.id);
      const overId = String(over.id);
      const overColumn = parseColumnDropId(overId);
      const targetStatus =
        overColumn ??
        statuses.find((status) =>
          (byStatus.get(status) ?? []).some((task) => task.id === overId),
        ) ??
        null;
      const dragged = tasks.find((task) => task.id === activeId);
      if (targetStatus === null || !dragged) {
        return;
      }

      const drop = resolveTaskBoardDrop({
        columnTasks: byStatus.get(targetStatus) ?? [],
        activeTaskId: activeId,
        overTaskId: overColumn === null ? overId : null,
      });
      const neighbours = resolveTaskDropNeighbours(drop.tasks, drop.index);
      // A drop back onto its own slot changes nothing; skip the write. The slot
      // is what has to match — a neighbour merely sharing the dragged card's
      // position would also swallow a real move onto the far side of it.
      const originalIndex = (byStatus.get(dragged.status) ?? []).findIndex(
        (task) => task.id === activeId,
      );
      if (dragged.status === targetStatus && drop.index === originalIndex) {
        return;
      }
      const move: TaskBoardMove = {
        taskId: activeId,
        status: targetStatus,
        beforePosition: neighbours.beforePosition,
        afterPosition: neighbours.afterPosition,
      };
      onMoveTask(move);
    },
    [byStatus, dragDisabled, onMoveTask, releaseClickSuppression, statuses, tasks],
  );

  if (isCompact) {
    const active = statuses.includes(selectedColumn) ? selectedColumn : statuses[0];
    return (
      <View style={styles.compact} testID="task-board">
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.columnPickerScroll}
        >
          <SegmentedControl
            size="sm"
            value={active ?? "backlog"}
            onValueChange={handleSelectColumn}
            options={statuses.map((status) => ({
              value: status,
              label: t(TASK_STATUS_LABEL_KEYS[status]),
            }))}
            testID="task-board-column-picker"
          />
        </ScrollView>
        {active ? (
          <TaskColumn
            serverId={serverId}
            status={active}
            rows={rowsByStatus.get(active)?.rows ?? []}
            count={rowsByStatus.get(active)?.storedCount ?? 0}
            labels={labels}
            projectsById={projectsById}
            executionByTaskId={executionByTaskId}
            relationshipsByTaskId={relationshipsByTaskId}
            onMoveToStatus={handleMoveToStatus}
            onCreateTask={onCreateTask}
            onOpenAgent={onOpenAgent}
            onOpenTask={onOpenTask}
            onReviewTask={onReviewTask}
            onStartReview={onStartReview}
            onDeleteTask={onDeleteTask}
            onCreateWorkflowForTask={onCreateWorkflowForTask}
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
      <ScrollView
        horizontal
        style={styles.boardScroll}
        contentContainerStyle={styles.wideRow}
        testID="task-board"
      >
        {statuses.map((status) => (
          <DroppableTaskColumn
            key={status}
            serverId={serverId}
            status={status}
            rows={rowsByStatus.get(status)?.rows ?? []}
            count={rowsByStatus.get(status)?.storedCount ?? 0}
            labels={labels}
            projectsById={projectsById}
            executionByTaskId={executionByTaskId}
            relationshipsByTaskId={relationshipsByTaskId}
            onMoveToStatus={handleMoveToStatus}
            onCreateTask={onCreateTask}
            onOpenAgent={handleOpenAgent}
            onOpenTask={onOpenTask}
            onReviewTask={onReviewTask}
            onStartReview={onStartReview}
            onDeleteTask={onDeleteTask}
            onCreateWorkflowForTask={onCreateWorkflowForTask}
            activeTaskId={activeTaskId}
            dragDisabled={dragDisabled}
          />
        ))}
      </ScrollView>
      <DragOverlay dropAnimation={null}>
        {activeTask ? (
          <TaskCard
            serverId={serverId}
            task={activeTask}
            project={projectsById.get(activeTask.projectId)}
            execution={executionByTaskId.get(activeTask.id)}
            relationships={relationshipsByTaskId.get(activeTask.id)}
            labels={labels}
            onMoveToStatus={handleMoveToStatus}
            onOpenAgent={handleOpenAgent}
            onReviewTask={onReviewTask}
            onStartReview={onStartReview}
            onDeleteTask={onDeleteTask}
            isOverlay
          />
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

/**
 * Every column is sortable, unlike the plan board where only Draft is: a task's
 * order is stored (`position`), so hand-ordering any column is a real write,
 * not a fight with a derived ordering.
 */
function DroppableTaskColumn({
  serverId,
  status,
  rows,
  count,
  labels,
  projectsById,
  executionByTaskId,
  relationshipsByTaskId,
  onMoveToStatus,
  onCreateTask,
  onOpenAgent,
  onOpenTask,
  onReviewTask,
  onStartReview,
  onDeleteTask,
  onCreateWorkflowForTask,
  activeTaskId,
  dragDisabled,
}: {
  serverId: string;
  status: TaskStatus;
  rows: readonly TaskBoardRow[];
  count: number;
  labels: TaskBoardProps["labels"];
  projectsById: TaskBoardProps["projectsById"];
  executionByTaskId: TaskBoardProps["executionByTaskId"];
  relationshipsByTaskId: TaskBoardProps["relationshipsByTaskId"];
  onMoveToStatus: (input: { taskId: string; status: TaskStatus }) => void;
  onCreateTask: (status: TaskStatus) => void;
  onOpenAgent: (input: { workspaceId: string; agentId: string }) => void;
  onOpenTask: (taskId: string) => void;
  onReviewTask: TaskBoardProps["onReviewTask"];
  onStartReview: TaskBoardProps["onStartReview"];
  onDeleteTask: (taskId: string) => void;
  onCreateWorkflowForTask?: ((taskId: string) => void) | undefined;
  activeTaskId: string | null;
  dragDisabled: boolean;
}): ReactElement {
  const { isOver, setNodeRef } = useDroppable({ id: columnDropId(status) });
  const sortableIds = useMemo(
    () => rows.filter((row) => !row.collapsed).map((row) => row.task.id),
    [rows],
  );

  // A card collapsed under its parent is registered as neither draggable nor
  // droppable: its slot here says nothing about where the task is stored.
  const renderCard = useCallback(
    (row: TaskBoardRow, card: ReactElement) =>
      row.collapsed ? (
        card
      ) : (
        <SortableTaskCard
          key={row.task.id}
          taskId={row.task.id}
          isDragSource={row.task.id === activeTaskId}
          disabled={dragDisabled}
        >
          {card}
        </SortableTaskCard>
      ),
    [activeTaskId, dragDisabled],
  );

  return (
    <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
      <TaskColumn
        serverId={serverId}
        status={status}
        rows={rows}
        count={count}
        labels={labels}
        projectsById={projectsById}
        executionByTaskId={executionByTaskId}
        relationshipsByTaskId={relationshipsByTaskId}
        onMoveToStatus={onMoveToStatus}
        onCreateTask={onCreateTask}
        onOpenAgent={onOpenAgent}
        onOpenTask={onOpenTask}
        onReviewTask={onReviewTask}
        onStartReview={onStartReview}
        onDeleteTask={onDeleteTask}
        onCreateWorkflowForTask={onCreateWorkflowForTask}
        isOver={isOver}
        renderCard={renderCard}
        bodyRef={setNodeRef}
      />
    </SortableContext>
  );
}

function SortableTaskCard({
  taskId,
  isDragSource,
  disabled,
  children,
}: {
  taskId: string;
  isDragSource: boolean;
  disabled: boolean;
  children: ReactElement;
}): ReactElement {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: taskId,
    disabled,
  });
  const style = useMemo<CSSProperties>(
    () => ({
      transform: CSS.Translate.toString(transform),
      transition,
      opacity: isDragging || isDragSource ? 0.4 : 1,
    }),
    [isDragging, isDragSource, transform, transition],
  );
  return (
    <div
      ref={setNodeRef}
      style={style}
      {...(disabled ? {} : attributes)}
      {...(disabled ? {} : listeners)}
    >
      {children}
    </div>
  );
}

const styles = StyleSheet.create((theme) => ({
  compact: {
    flex: 1,
    minHeight: 0,
    gap: theme.spacing[3],
    padding: theme.spacing[3],
  },
  columnPickerScroll: { flexGrow: 0, flexShrink: 0, height: 32 },
  boardScroll: { flex: 1, minHeight: 0 },
  wideRow: {
    flexGrow: 1,
    height: "100%",
    flexDirection: "row",
    gap: theme.spacing[3],
    padding: theme.spacing[3],
    alignItems: "stretch",
  },
}));
