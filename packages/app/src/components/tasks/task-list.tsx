import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import {
  Pressable,
  ScrollView,
  Text,
  View,
  type LayoutChangeEvent,
  type PressableStateCallbackType,
} from "react-native";
import { useTranslation } from "react-i18next";
import { Link2, ListTree, MessageSquare, MoreVertical, Paperclip } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  TASK_PRIORITIES,
  TASK_STATUSES,
  type Task,
  type TaskPriority,
  type TaskProject,
  type TaskStatus,
} from "@getpaseo/protocol/tasks/types";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { DropdownTrigger } from "@/components/ui/dropdown-trigger";
import {
  formatTaskKey,
  groupSubtasksUnderParents,
  groupTasksByStatus,
  partitionTaskLabels,
  resolveTaskLabels,
} from "@/tasks/task-views";
import { ICON_SIZE, SPACING, type Theme } from "@/styles/theme";
import {
  TASK_PRIORITY_LABEL_KEYS,
  TASK_STATUS_LABEL_KEYS,
  TaskLabelChips,
  groupBoardTasks,
  useMoveToStatusEnd,
  useTaskActions,
  type TaskBoardProps,
} from "./task-board-parts";
import { TaskExecutionSummary } from "./task-execution-summary";
import type { TaskRelationshipSummary } from "@/tasks/task-views";
import type {
  TaskExecutionEntry,
  TaskExecutionSummary as TaskExecutionSummaryModel,
} from "@/tasks/task-execution";

const ThemedMessageSquare = withUnistyles(MessageSquare);
const ThemedMoreVertical = withUnistyles(MoreVertical);
const ThemedPaperclip = withUnistyles(Paperclip);
const ThemedListTree = withUnistyles(ListTree);
const ThemedLink = withUnistyles(Link2);
const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const foregroundIconMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const SUBTASK_INDENT = SPACING[3];
const NO_EXECUTION_ENTRIES: readonly TaskExecutionEntry[] = [];

type TaskListProps = Pick<
  TaskBoardProps,
  | "tasks"
  | "labels"
  | "projectsById"
  | "executionByTaskId"
  | "relationshipsByTaskId"
  | "onMoveTask"
  | "onOpenAgent"
  | "onOpenTask"
  | "onReviewTask"
  | "onStartReview"
  | "onDeleteTask"
  | "onCreateWorkflowForTask"
> & {
  onSetPriority: (input: { taskId: string; priority: TaskPriority }) => void;
  totalCount: number;
  initialScrollOffset: number;
  onScrollOffsetChange: (offset: number) => void;
};

/** The get-bb-style working list for the same collection the board renders.
 * Status and priority are direct row controls; the overflow holds incidental actions. */
export function TaskList({
  tasks,
  labels,
  projectsById,
  executionByTaskId,
  relationshipsByTaskId,
  onMoveTask,
  onOpenAgent,
  onOpenTask,
  onReviewTask,
  onStartReview,
  onDeleteTask,
  onCreateWorkflowForTask,
  onSetPriority,
  totalCount,
  initialScrollOffset,
  onScrollOffsetChange,
}: TaskListProps): ReactElement {
  const { t } = useTranslation();
  const groups = useMemo(() => groupTasksByStatus(tasks), [tasks]);
  const byStatus = useMemo(() => groupBoardTasks(TASK_STATUSES, tasks), [tasks]);
  const handleMoveToStatus = useMoveToStatusEnd(byStatus, onMoveTask);
  const [listWidth, setListWidth] = useState(0);
  const compactRows = listWidth > 0 && listWidth < 620;
  const scrollRef = useRef<ScrollView>(null);
  const restoredInitialScrollOffset = useRef(initialScrollOffset);
  const scrollSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const restoreTimer = setTimeout(() => {
      scrollRef.current?.scrollTo({ y: restoredInitialScrollOffset.current, animated: false });
    }, 0);
    return () => {
      clearTimeout(restoreTimer);
      if (scrollSaveTimer.current) clearTimeout(scrollSaveTimer.current);
    };
  }, []);
  const handleScroll = useCallback(
    (event: { nativeEvent: { contentOffset: { y: number } } }) => {
      const offset = event.nativeEvent.contentOffset.y;
      if (scrollSaveTimer.current) clearTimeout(scrollSaveTimer.current);
      scrollSaveTimer.current = setTimeout(() => onScrollOffsetChange(offset), 150);
    },
    [onScrollOffsetChange],
  );
  const handleLayout = useCallback(
    (event: LayoutChangeEvent) => setListWidth(event.nativeEvent.layout.width),
    [],
  );
  const stickyHeaderIndices = useMemo(() => {
    const indices: number[] = [];
    let childIndex = 0;
    for (const group of groups) {
      indices.push(childIndex);
      childIndex += group.tasks.length + 1;
    }
    return indices;
  }, [groups]);
  const listChildren: ReactElement[] = [];
  for (const group of groups) {
    listChildren.push(
      <View
        key={`header:${group.status}`}
        style={styles.groupHeader}
        testID={`task-list-group-${group.status}`}
      >
        <TaskStatusDot status={group.status} />
        <Text style={styles.groupTitle}>{t(TASK_STATUS_LABEL_KEYS[group.status])}</Text>
        <Text style={styles.groupCount}>{group.tasks.length}</Text>
      </View>,
    );
    for (const { task, depth } of groupSubtasksUnderParents(group.tasks)) {
      listChildren.push(
        <TaskListRow
          key={task.id}
          task={task}
          depth={depth}
          compact={compactRows}
          labels={labels}
          project={projectsById.get(task.projectId)}
          execution={executionByTaskId.get(task.id)}
          relationships={relationshipsByTaskId.get(task.id)}
          onMoveToStatus={handleMoveToStatus}
          onSetPriority={onSetPriority}
          onOpenAgent={onOpenAgent}
          onOpenTask={onOpenTask}
          onReviewTask={onReviewTask}
          onStartReview={onStartReview}
          onDeleteTask={onDeleteTask}
          onCreateWorkflowForTask={onCreateWorkflowForTask}
        />,
      );
    }
  }

  return (
    <ScrollView
      ref={scrollRef}
      style={styles.list}
      contentContainerStyle={styles.listContent}
      stickyHeaderIndices={stickyHeaderIndices}
      testID="task-list"
      onLayout={handleLayout}
      onScroll={handleScroll}
      scrollEventThrottle={100}
    >
      {listChildren}
      {tasks.length === 0 ? (
        <Text style={styles.empty}>
          {totalCount > 0 ? "No tasks match these filters" : t("tasks.screen.empty")}
        </Text>
      ) : null}
    </ScrollView>
  );
}

function TaskStatusDot({ status }: { status: TaskStatus }): ReactElement {
  return (
    <View
      style={[
        styles.statusDot,
        status === "todo" && styles.statusTodo,
        status === "in_progress" && styles.statusWorking,
        status === "in_review" && styles.statusReview,
        status === "done" && styles.statusDone,
        status === "canceled" && styles.statusCanceled,
      ]}
    />
  );
}

function TaskListRow({
  task,
  depth,
  compact,
  labels,
  project,
  execution,
  relationships,
  onMoveToStatus,
  onSetPriority,
  onOpenAgent,
  onOpenTask,
  onReviewTask,
  onStartReview,
  onDeleteTask,
  onCreateWorkflowForTask,
}: {
  task: Task;
  depth: number;
  compact: boolean;
  labels: TaskListProps["labels"];
  project: TaskProject | undefined;
  execution: TaskExecutionSummaryModel | undefined;
  relationships: TaskRelationshipSummary | undefined;
  onMoveToStatus: (input: { taskId: string; status: TaskStatus }) => void;
  onSetPriority: TaskListProps["onSetPriority"];
  onOpenAgent: TaskListProps["onOpenAgent"];
  onOpenTask: TaskListProps["onOpenTask"];
  onReviewTask: TaskListProps["onReviewTask"];
  onStartReview: TaskListProps["onStartReview"];
  onDeleteTask: TaskListProps["onDeleteTask"];
  onCreateWorkflowForTask: TaskListProps["onCreateWorkflowForTask"];
}): ReactElement {
  const { t } = useTranslation();
  const handleOpenTask = useCallback(() => onOpenTask(task.id), [onOpenTask, task.id]);
  const rowMainStyle = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.rowMain,
      compact && styles.rowMainCompact,
      depth > 0 && { paddingLeft: depth * SUBTASK_INDENT },
      Boolean(hovered) && styles.rowMainHover,
      pressed && styles.rowMainPressed,
    ],
    [compact, depth],
  );
  const taskLabels = useMemo(() => resolveTaskLabels(task, labels), [labels, task]);
  const partitionedLabels = useMemo(() => partitionTaskLabels(taskLabels, 2), [taskLabels]);
  const actions = useTaskActions({
    task,
    hasSubtasks: (relationships?.subtaskCount ?? 0) > 0,
    executionEntries: execution?.entries ?? NO_EXECUTION_ENTRIES,
    onMoveToStatus,
    onOpenAgent,
    onOpenTask,
    onReviewTask,
    onStartReview,
    onDeleteTask,
    onCreateWorkflowForTask,
  });

  return (
    <View style={[styles.row, compact && styles.rowCompact]} testID={`task-list-row-${task.id}`}>
      <TaskStatusEditor task={task} onMoveToStatus={onMoveToStatus} />
      <TaskPriorityEditor task={task} onSetPriority={onSetPriority} />
      <Pressable onPress={handleOpenTask} style={rowMainStyle} accessibilityRole="button">
        <View style={styles.identity}>
          <Text style={styles.key} numberOfLines={1} testID={`task-list-key-${task.id}`}>
            {formatTaskKey(project, task)}
          </Text>
        </View>
        <Text style={[styles.title, compact && styles.titleCompact]} numberOfLines={1}>
          {task.title}
        </Text>
        <TaskExecutionSummary summary={execution} compact={compact} />
        {!compact ? <TaskLabelChips labels={partitionedLabels.visible} /> : null}
        {!compact && partitionedLabels.hidden.length > 0 ? (
          <Text style={styles.moreLabels}>+{partitionedLabels.hidden.length}</Text>
        ) : null}
        <TaskListCounts task={task} relationships={relationships} />
      </Pressable>
      <DropdownMenu>
        <DropdownMenuTrigger
          style={styles.menuTrigger}
          testID={`task-list-menu-${task.id}`}
          accessibilityRole="button"
          accessibilityLabel={t("tasks.board.changeStatus")}
        >
          {({ hovered, open }) => (
            <ThemedMoreVertical
              size={ICON_SIZE.sm}
              uniProps={hovered || open ? foregroundIconMapping : mutedIconMapping}
            />
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent side="bottom" align="end">
          {actions.map((action) => (
            <DropdownMenuItem key={action.key} testID={action.testID} onSelect={action.onSelect}>
              {action.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </View>
  );
}

function TaskStatusEditor({
  task,
  onMoveToStatus,
}: {
  task: Task;
  onMoveToStatus: (input: { taskId: string; status: TaskStatus }) => void;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <DropdownMenu>
      <DropdownTrigger
        style={styles.propertyTrigger}
        chevron={null}
        accessibilityLabel={t(TASK_STATUS_LABEL_KEYS[task.status])}
        testID={`task-list-status-${task.id}`}
      >
        <TaskStatusDot status={task.status} />
      </DropdownTrigger>
      <DropdownMenuContent align="start">
        {TASK_STATUSES.map((status) => (
          <TaskStatusOption
            key={status}
            task={task}
            status={status}
            label={t(TASK_STATUS_LABEL_KEYS[status])}
            onMoveToStatus={onMoveToStatus}
          />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function TaskStatusOption({
  task,
  status,
  label,
  onMoveToStatus,
}: {
  task: Task;
  status: TaskStatus;
  label: string;
  onMoveToStatus: (input: { taskId: string; status: TaskStatus }) => void;
}): ReactElement {
  const handleSelect = useCallback(
    () => onMoveToStatus({ taskId: task.id, status }),
    [onMoveToStatus, status, task.id],
  );
  return (
    <DropdownMenuItem
      selected={status === task.status}
      showSelectedCheck
      testID={`task-list-status-${task.id}-${status}`}
      onSelect={handleSelect}
    >
      {label}
    </DropdownMenuItem>
  );
}

function TaskPriorityEditor({
  task,
  onSetPriority,
}: {
  task: Task;
  onSetPriority: TaskListProps["onSetPriority"];
}): ReactElement {
  const { t } = useTranslation();
  const label = task.priority === "none" ? "—" : t(TASK_PRIORITY_LABEL_KEYS[task.priority]);
  return (
    <DropdownMenu>
      <DropdownTrigger
        style={styles.priorityTrigger}
        chevron={null}
        accessibilityLabel={label}
        testID={`task-list-priority-${task.id}`}
      >
        <Text
          style={[
            styles.priority,
            task.priority === "urgent" && styles.priorityDanger,
            task.priority === "high" && styles.priorityWarning,
          ]}
        >
          {label}
        </Text>
      </DropdownTrigger>
      <DropdownMenuContent align="start">
        {TASK_PRIORITIES.map((priority) => (
          <TaskPriorityOption
            key={priority}
            task={task}
            priority={priority}
            label={
              priority === "none"
                ? t("tasks.detail.priorityNone")
                : t(TASK_PRIORITY_LABEL_KEYS[priority])
            }
            onSetPriority={onSetPriority}
          />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function TaskPriorityOption({
  task,
  priority,
  label,
  onSetPriority,
}: {
  task: Task;
  priority: TaskPriority;
  label: string;
  onSetPriority: TaskListProps["onSetPriority"];
}): ReactElement {
  const handleSelect = useCallback(
    () => onSetPriority({ taskId: task.id, priority }),
    [onSetPriority, priority, task.id],
  );
  return (
    <DropdownMenuItem
      selected={priority === task.priority}
      showSelectedCheck
      testID={`task-list-priority-${task.id}-${priority}`}
      onSelect={handleSelect}
    >
      {label}
    </DropdownMenuItem>
  );
}

function TaskListCounts({
  task,
  relationships,
}: {
  task: Task;
  relationships: TaskRelationshipSummary | undefined;
}): ReactElement | null {
  const subtaskCount = relationships?.subtaskCount ?? 0;
  const blockerCount = relationships?.blockerCount ?? 0;
  if (
    task.commentCount === 0 &&
    task.attachments.length === 0 &&
    subtaskCount === 0 &&
    blockerCount === 0
  ) {
    return null;
  }
  return (
    <View style={styles.counts}>
      {task.commentCount > 0 ? (
        <View style={styles.count}>
          <ThemedMessageSquare size={12} uniProps={mutedIconMapping} />
          <Text style={styles.countText}>{task.commentCount}</Text>
        </View>
      ) : null}
      {task.attachments.length > 0 ? (
        <View style={styles.count}>
          <ThemedPaperclip size={12} uniProps={mutedIconMapping} />
          <Text style={styles.countText}>{task.attachments.length}</Text>
        </View>
      ) : null}
      {subtaskCount > 0 ? (
        <View style={styles.count}>
          <ThemedListTree size={12} uniProps={mutedIconMapping} />
          <Text style={styles.countText}>{subtaskCount}</Text>
        </View>
      ) : null}
      {blockerCount > 0 ? (
        <View style={styles.count}>
          <ThemedLink size={12} uniProps={mutedIconMapping} />
          <Text style={styles.countText}>{blockerCount}</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  list: { flex: 1, minHeight: 0 },
  listContent: { padding: theme.spacing[3], paddingBottom: theme.spacing[6] },
  groupHeader: {
    minHeight: 30,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    backgroundColor: theme.colors.surface0,
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  groupTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  groupCount: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.xs },
  statusDot: {
    width: 10,
    height: 10,
    borderRadius: theme.borderRadius.full,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.foregroundMuted,
  },
  statusTodo: { borderColor: theme.colors.foreground },
  statusWorking: {
    borderColor: theme.colors.statusDotRunning,
    backgroundColor: theme.colors.statusDotRunning,
  },
  statusReview: {
    borderColor: theme.colors.statusDotSuccess,
    backgroundColor: theme.colors.statusDotSuccess,
  },
  statusDone: {
    borderColor: theme.colors.statusSuccess,
    backgroundColor: theme.colors.statusSuccess,
  },
  statusCanceled: { borderColor: theme.colors.statusDanger },
  row: {
    minHeight: 38,
    flexDirection: "row",
    alignItems: "center",
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
    paddingRight: theme.spacing[1],
  },
  rowCompact: { minHeight: 54 },
  propertyTrigger: {
    width: 28,
    height: 38,
    alignItems: "center",
    justifyContent: "center",
  },
  priorityTrigger: {
    width: 58,
    height: 38,
    alignItems: "flex-start",
    justifyContent: "center",
  },
  rowMain: {
    flex: 1,
    minWidth: 0,
    minHeight: 38,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
  },
  rowMainCompact: {
    minHeight: 54,
    flexDirection: "column",
    alignItems: "flex-start",
    justifyContent: "center",
    flexWrap: "wrap",
    gap: theme.spacing[0.5],
    paddingVertical: theme.spacing[1],
  },
  rowMainHover: { backgroundColor: theme.colors.surface1 },
  rowMainPressed: { backgroundColor: theme.colors.surface2 },
  key: {
    width: 88,
    flexShrink: 0,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  identity: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  title: {
    flex: 1,
    minWidth: 100,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  titleCompact: { flex: 0, width: "100%", minWidth: 0 },
  moreLabels: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.xs },
  priority: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.xs },
  priorityDanger: { color: theme.colors.statusDanger },
  priorityWarning: { color: theme.colors.statusWarning },
  counts: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  count: { flexDirection: "row", alignItems: "center", gap: theme.spacing[1] },
  countText: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.xs },
  menuTrigger: { width: 28, height: 28, alignItems: "center", justifyContent: "center" },
  empty: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
    padding: theme.spacing[6],
  },
}));
