import { useCallback, useMemo, type ReactElement } from "react";
import { ScrollView, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { Link2, ListTree, MessageSquare, MoreVertical, Paperclip, Plus } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type {
  Task,
  TaskLabel,
  TaskPriority,
  TaskProject,
  TaskStatus,
} from "@getpaseo/protocol/tasks/types";
import { TASK_STATUSES } from "@getpaseo/protocol/tasks/types";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { useTaskLacksPlan } from "@/tasks/use-tasks";
import {
  formatAggregateChildStates,
  formatTaskKey,
  resolveTaskLabels,
  type TaskBoardRow,
  type TaskRelationshipSummary,
} from "@/tasks/task-views";
import { ICON_SIZE, SPACING, type Theme } from "@/styles/theme";
import {
  canStartTaskReview,
  type TaskExecutionEntry,
  type TaskExecutionSummary as TaskExecutionSummaryModel,
} from "@/tasks/task-execution";
import { TaskExecutionSummary } from "./task-execution-summary";

const ThemedMoreVertical = withUnistyles(MoreVertical);
const ThemedMessageSquare = withUnistyles(MessageSquare);
const ThemedPaperclip = withUnistyles(Paperclip);
const ThemedListTree = withUnistyles(ListTree);
const ThemedLink = withUnistyles(Link2);
const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const foregroundIconMapping = (theme: Theme) => ({ color: theme.colors.foreground });

export interface TaskCardAction {
  key: string;
  label: string;
  testID: string;
  onSelect: () => void;
  /** Offered but refused: the daemon would say no, and a menu that hides the row
   * teaches nothing about why. */
  disabled?: boolean;
}

export function useTaskActions({
  task,
  hasSubtasks,
  executionEntries,
  onMoveToStatus,
  onOpenAgent,
  onOpenTask,
  onReviewTask,
  onStartReview,
  onDeleteTask,
  onCreateWorkflowForTask,
}: {
  task: Task;
  /** A task with subtasks is an aggregate: it holds no workers of its own, so a
   * plan cannot run on it. */
  hasSubtasks: boolean;
  /** Its attached agents as the cards read them, for the review predicate. */
  executionEntries: readonly TaskExecutionEntry[];
  onMoveToStatus: (input: { taskId: string; status: TaskStatus }) => void;
  onOpenAgent: (input: { workspaceId: string; agentId: string }) => void;
  onOpenTask?: ((taskId: string) => void) | undefined;
  onReviewTask: (input: {
    taskId: string;
    verdict: "approve" | "reject";
    feedback?: string;
  }) => void;
  /** Arms a reviewer for a card in review that has none. */
  onStartReview: (taskId: string) => void;
  onDeleteTask: (taskId: string) => void;
  onCreateWorkflowForTask?: ((taskId: string) => void) | undefined;
}): TaskCardAction[] {
  const { t } = useTranslation();
  return useMemo(() => {
    const entries: TaskCardAction[] = [];
    if (onOpenTask) {
      entries.push({
        key: "details",
        label: t("tasks.detail.menuLabel"),
        testID: `task-card-details-${task.id}`,
        onSelect: () => onOpenTask(task.id),
      });
    }
    if (canStartTaskReview({ status: task.status, entries: executionEntries })) {
      entries.push({
        key: "start-review",
        label: t("tasks.board.startReview"),
        testID: `task-card-start-review-${task.id}`,
        onSelect: () => onStartReview(task.id),
      });
    }
    if (task.status === "in_review") {
      entries.push(
        {
          key: "approve",
          label: t("tasks.board.approve"),
          testID: `task-card-approve-${task.id}`,
          onSelect: () => onReviewTask({ taskId: task.id, verdict: "approve" }),
        },
        {
          key: "reject",
          label: t("tasks.board.reject"),
          testID: `task-card-reject-${task.id}`,
          onSelect: () => onReviewTask({ taskId: task.id, verdict: "reject" }),
        },
      );
    }
    if (onCreateWorkflowForTask) {
      entries.push({
        key: "add-workflow",
        label: t("tasks.workflow.addToTask"),
        testID: `task-card-add-workflow-${task.id}`,
        onSelect: () => onCreateWorkflowForTask(task.id),
        disabled: hasSubtasks,
      });
    }
    for (const link of task.agents) {
      entries.push({
        key: `open-agent-${link.agentId}`,
        label: t("tasks.board.openAgent"),
        testID: `task-card-open-agent-${task.id}-${link.agentId}`,
        onSelect: () => onOpenAgent({ workspaceId: link.workspaceId, agentId: link.agentId }),
      });
    }
    for (const status of TASK_STATUSES) {
      if (status === task.status) {
        continue;
      }
      entries.push({
        key: status,
        label: t(TASK_STATUS_LABEL_KEYS[status]),
        testID: `task-card-status-${task.id}-${status}`,
        onSelect: () => onMoveToStatus({ taskId: task.id, status }),
      });
    }
    entries.push({
      key: "delete",
      label: t("tasks.board.delete"),
      testID: `task-card-delete-${task.id}`,
      onSelect: () => onDeleteTask(task.id),
    });
    return entries;
  }, [
    executionEntries,
    hasSubtasks,
    onCreateWorkflowForTask,
    onDeleteTask,
    onMoveToStatus,
    onOpenAgent,
    onOpenTask,
    onReviewTask,
    onStartReview,
    t,
    task,
  ]);
}

export const TASK_PRIORITY_LABEL_KEYS: Record<Exclude<TaskPriority, "none">, string> = {
  urgent: "tasks.priority.urgent",
  high: "tasks.priority.high",
  medium: "tasks.priority.medium",
  low: "tasks.priority.low",
};

/** Urgency reads as color; the two calm tiers stay muted so the title wins. */
const PRIORITY_STYLE_KEYS: Record<Exclude<TaskPriority, "none">, "danger" | "warning" | "muted"> = {
  urgent: "danger",
  high: "warning",
  medium: "muted",
  low: "muted",
};

export const TASK_STATUS_LABEL_KEYS: Record<TaskStatus, string> = {
  backlog: "tasks.status.backlog",
  todo: "tasks.status.todo",
  in_progress: "tasks.status.inProgress",
  in_review: "tasks.status.inReview",
  done: "tasks.status.done",
  canceled: "tasks.status.canceled",
};

/** A drop or a menu pick: where the task goes and between which neighbours. */
export interface TaskBoardMove {
  taskId: string;
  status: TaskStatus;
  beforePosition: number | null;
  afterPosition: number | null;
}

export interface TaskBoardProps {
  serverId: string;
  /** Pre-filtered to this board's projects and manual-sorted by the caller. */
  tasks: readonly Task[];
  labels: readonly TaskLabel[];
  projectsById: ReadonlyMap<string, TaskProject>;
  executionByTaskId: ReadonlyMap<string, TaskExecutionSummaryModel>;
  relationshipsByTaskId: ReadonlyMap<string, TaskRelationshipSummary>;
  onMoveTask: (move: TaskBoardMove) => void;
  /** The column's own "+" captures straight into that status. */
  onCreateTask: (status: TaskStatus) => void;
  /** Opens the per-agent conversation from a menu row. */
  onOpenAgent: (input: { workspaceId: string; agentId: string }) => void;
  /** A press on the card always opens the detail sheet. */
  onOpenTask: (taskId: string) => void;
  /** The verdict on an In Review card — distinct from a status move, because
   * reject routes through the board's review.onReject. */
  onReviewTask: (input: {
    taskId: string;
    verdict: "approve" | "reject";
    feedback?: string;
  }) => void;
  /** Arms a reviewer for a card in review that has none, which is the only
   * gesture a stalled review offers. */
  onStartReview: (taskId: string) => void;
  onDeleteTask: (taskId: string) => void;
  /** Authors a plan already attached to the task, when the surface offers one. */
  onCreateWorkflowForTask?: (taskId: string) => void;
  selectedColumn: TaskStatus;
  onSelectColumn: (status: TaskStatus) => void;
  /** Draws subtasks in their own status columns instead of under their parent. */
  expandSubtasks: boolean;
  /** Filtered or computed ordering cannot be persisted as a manual drop. */
  dragDisabled?: boolean;
}

/** Enough to read as "under", not so much that a deep card runs out of width. */
const SUBTASK_INDENT = SPACING[3];

const NO_EXECUTION_ENTRIES: readonly TaskExecutionEntry[] = [];

/** A label is a glance, not a read: past this it truncates rather than pushing
 * the ones after it off the card. */
const CHIP_MAX_WIDTH = 120;

export function groupBoardTasks(
  statuses: readonly TaskStatus[],
  tasks: readonly Task[],
): Map<TaskStatus, Task[]> {
  const map = new Map<TaskStatus, Task[]>(statuses.map((status) => [status, []]));
  for (const task of tasks) {
    map.get(task.status)?.push(task);
  }
  return map;
}

/** A menu pick has no drop slot, so the task lands at the end of its new column. */
export function useMoveToStatusEnd(
  byStatus: ReadonlyMap<TaskStatus, Task[]>,
  onMoveTask: (move: TaskBoardMove) => void,
): (input: { taskId: string; status: TaskStatus }) => void {
  return useCallback(
    ({ taskId, status }) => {
      const column = byStatus.get(status) ?? [];
      const last = column.length > 0 ? column[column.length - 1] : undefined;
      onMoveTask({
        taskId,
        status,
        beforePosition: last?.position ?? null,
        afterPosition: null,
      });
    },
    [byStatus, onMoveTask],
  );
}

export function TaskColumn({
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
  isOver = false,
  renderCard,
  bodyRef,
}: {
  serverId: string;
  status: TaskStatus;
  /** Already projected by the caller: which cards this column draws, and how
   * deep each one sits under its parent. */
  rows: readonly TaskBoardRow[];
  /** Tasks stored in this status. Independent of the projection, so a card drawn
   * under a parent in another column is still counted here and only here. */
  count: number;
  labels: readonly TaskLabel[];
  projectsById: ReadonlyMap<string, TaskProject>;
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
  isOver?: boolean;
  /** Lets the web board wrap each card in a sortable without forking the column. */
  renderCard?: (row: TaskBoardRow, card: ReactElement) => ReactElement;
  /** Registers the column body as a drop target on web. */
  bodyRef?: (element: never) => void;
}): ReactElement {
  const { t } = useTranslation();
  const handleCreate = useCallback(() => onCreateTask(status), [onCreateTask, status]);

  return (
    <View style={styles.column} testID={`task-column-${status}`}>
      <View style={styles.columnHeader}>
        <Text style={styles.columnTitle}>{t(TASK_STATUS_LABEL_KEYS[status])}</Text>
        <Text style={styles.columnCount}>{count}</Text>
        <Button
          variant="ghost"
          size="sm"
          leftIcon={Plus}
          onPress={handleCreate}
          style={styles.addButton}
          accessibilityLabel={t("tasks.board.addTask")}
          testID={`task-column-add-${status}`}
        />
      </View>
      <View
        ref={bodyRef as never}
        style={[styles.columnBody, isOver && styles.columnBodyOver]}
        testID={`task-column-body-${status}`}
      >
        <ScrollView
          style={styles.columnScroll}
          contentContainerStyle={styles.columnCards}
          showsVerticalScrollIndicator={false}
        >
          {rows.map((row) => {
            const card = (
              <TaskCard
                key={row.task.id}
                serverId={serverId}
                task={row.task}
                depth={row.depth}
                project={projectsById.get(row.task.projectId)}
                execution={executionByTaskId.get(row.task.id)}
                relationships={relationshipsByTaskId.get(row.task.id)}
                labels={labels}
                onMoveToStatus={onMoveToStatus}
                onOpenAgent={onOpenAgent}
                onOpenTask={onOpenTask}
                onReviewTask={onReviewTask}
                onStartReview={onStartReview}
                onDeleteTask={onDeleteTask}
                onCreateWorkflowForTask={onCreateWorkflowForTask}
              />
            );
            return renderCard ? renderCard(row, card) : card;
          })}
          {rows.length === 0 ? (
            <View style={styles.empty}>
              <Text style={styles.emptyText}>{t("tasks.board.emptyColumn")}</Text>
            </View>
          ) : null}
        </ScrollView>
      </View>
    </View>
  );
}

export function TaskCard({
  serverId,
  task,
  project,
  execution,
  relationships,
  labels,
  onMoveToStatus,
  onOpenAgent,
  onOpenTask,
  onReviewTask,
  onStartReview,
  onDeleteTask,
  onCreateWorkflowForTask,
  depth = 0,
  isOverlay = false,
  isDragSource = false,
}: {
  serverId: string;
  task: Task;
  /** How far under its parent this card sits in the column it was projected
   * into. Indent only — a subtask is a task in every other respect. */
  depth?: number;
  project: TaskProject | undefined;
  execution: TaskExecutionSummaryModel | undefined;
  relationships: TaskRelationshipSummary | undefined;
  labels: readonly TaskLabel[];
  onMoveToStatus: (input: { taskId: string; status: TaskStatus }) => void;
  onOpenAgent: (input: { workspaceId: string; agentId: string }) => void;
  /** Absent only in the drag overlay clone, which renders no press target. */
  onOpenTask?: (taskId: string) => void;
  onReviewTask: TaskBoardProps["onReviewTask"];
  onStartReview: TaskBoardProps["onStartReview"];
  onDeleteTask: (taskId: string) => void;
  onCreateWorkflowForTask?: ((taskId: string) => void) | undefined;
  /** Rendered inside the drag overlay: lifted, non-interactive. */
  isOverlay?: boolean;
  /** The in-column original while its overlay clone is being dragged. */
  isDragSource?: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const taskLabels = resolveTaskLabels(task, labels);
  const handlePress = useCallback(() => {
    onOpenTask?.(task.id);
  }, [onOpenTask, task.id]);
  // A card left in Working with nothing to run carries the offer itself, rather
  // than the board announcing it at the moment of the move: whoever is tracking
  // their own work by hand can ignore it for as long as they like.
  const lacksPlan = useTaskLacksPlan(serverId, task);
  const handleAddWorkflow = useCallback(() => {
    onCreateWorkflowForTask?.(task.id);
  }, [onCreateWorkflowForTask, task.id]);

  // One list feeds the kebab and the right-click menu, so a card is reachable
  // the way any other card on this platform is.
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

  const body = (
    <>
      <View style={[styles.cardHeader, !isOverlay && styles.cardHeaderWithMenu]}>
        <Text style={styles.cardKey}>{formatTaskKey(project, task)}</Text>
        {task.priority !== "none" ? (
          <Text
            style={[
              styles.priority,
              PRIORITY_STYLE_KEYS[task.priority] === "danger" && styles.priorityDanger,
              PRIORITY_STYLE_KEYS[task.priority] === "warning" && styles.priorityWarning,
            ]}
          >
            {t(TASK_PRIORITY_LABEL_KEYS[task.priority])}
          </Text>
        ) : null}
      </View>
      <Text style={styles.cardTitle} numberOfLines={3}>
        {task.title}
      </Text>
      <TaskExecutionSummary summary={execution} />
      <TaskAggregateChildStates task={task} relationships={relationships} />
      <TaskLabelChips labels={taskLabels} />
      <TaskCardCounts task={task} relationships={relationships} />
    </>
  );

  const cardStyle = [
    styles.card,
    depth > 0 && { marginLeft: depth * SUBTASK_INDENT },
    isOverlay && styles.cardOverlay,
    isDragSource && styles.cardDragSource,
  ];
  if (isOverlay) {
    return (
      <View style={cardStyle} testID={`task-card-${task.id}`}>
        {body}
      </View>
    );
  }

  // Long press is left alone: on a touch board it is how a card is picked up.
  return (
    <ContextMenu>
      <View style={cardStyle}>
        <ContextMenuTrigger
          onPress={handlePress}
          style={styles.cardPressTarget}
          testID={`task-card-${task.id}`}
          accessibilityRole="button"
          enabledOnMobile={false}
        >
          {body}
        </ContextMenuTrigger>
        <DropdownMenu>
          <DropdownMenuTrigger
            style={styles.menuTrigger}
            testID={`task-card-status-${task.id}`}
            accessibilityRole="button"
            accessibilityLabel={t("tasks.board.changeStatus")}
          >
            {({ hovered }) => (
              <ThemedMoreVertical
                size={ICON_SIZE.sm}
                uniProps={hovered ? foregroundIconMapping : mutedIconMapping}
              />
            )}
          </DropdownMenuTrigger>
          <DropdownMenuContent side="bottom" align="end">
            {actions.map((action) => (
              <DropdownMenuItem
                key={action.key}
                testID={action.testID}
                disabled={action.disabled}
                onSelect={action.onSelect}
              >
                {action.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        {lacksPlan && onCreateWorkflowForTask ? (
          <Button
            variant="ghost"
            size="sm"
            leftIcon={Plus}
            onPress={handleAddWorkflow}
            style={styles.addPlan}
            testID={`task-card-add-plan-${task.id}`}
          >
            {t("tasks.workflow.addToTask")}
          </Button>
        ) : null}
      </View>
      <ContextMenuContent align="start" width={220} testID={`task-card-context-menu-${task.id}`}>
        {actions.map((action) => (
          <ContextMenuItem
            key={action.key}
            testID={`task-card-context-action-${task.id}-${action.key}`}
            disabled={action.disabled}
            onSelect={action.onSelect}
          >
            {action.label}
          </ContextMenuItem>
        ))}
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** An aggregate has no execution of its own to summarize, so its card reads the
 * state of its children instead. */
function TaskAggregateChildStates({
  task,
  relationships,
}: {
  task: Task;
  relationships: TaskRelationshipSummary | undefined;
}): ReactElement | null {
  const states = formatAggregateChildStates(relationships);
  if (!states) {
    return null;
  }
  return (
    <Text style={styles.countText} testID={`task-card-child-states-${task.id}`}>
      {states}
    </Text>
  );
}

/** The card's label row, reused by the detail sheet so a task's labels look
 * the same wherever they show up. */
/** Comments and attachments, counted on the card. A card that has been argued
 * over for twenty messages looks different from one nobody has touched, and
 * that difference is worth a glance rather than a click. */
function TaskCardCounts({
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
    <View style={styles.counts} testID={`task-card-counts-${task.id}`}>
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
          <Text style={styles.countText}>
            {subtaskCount} {subtaskCount === 1 ? "subtask" : "subtasks"}
          </Text>
        </View>
      ) : null}
      {blockerCount > 0 ? (
        <View style={styles.count}>
          <ThemedLink size={12} uniProps={mutedIconMapping} />
          <Text style={styles.countText}>
            {blockerCount} {blockerCount === 1 ? "blocker" : "blockers"}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

export function TaskLabelChips({ labels }: { labels: readonly TaskLabel[] }): ReactElement | null {
  if (labels.length === 0) {
    return null;
  }
  return (
    <View style={styles.cardLabels}>
      {labels.map((label) => (
        <View key={label.id} style={styles.chip}>
          <View style={[styles.chipDot, { backgroundColor: label.color }]} />
          <Text style={styles.chipText} numberOfLines={1}>
            {label.name}
          </Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  compact: {
    gap: theme.spacing[3],
    padding: theme.spacing[3],
  },
  wideRow: {
    flexDirection: "row",
    gap: theme.spacing[3],
    padding: theme.spacing[3],
    alignItems: "flex-start",
  },
  column: {
    flexGrow: 1,
    height: "100%",
    minHeight: 0,
    minWidth: 264,
    maxWidth: 360,
    gap: theme.spacing[1],
  },
  columnHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[1.5],
  },
  columnTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  columnCount: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  addButton: {
    marginLeft: "auto",
  },
  /**
   * The column body is the drop target, so it has to read as a surface even when
   * empty — an unbounded stack of cards gives a drag nothing to aim at.
   */
  columnBody: {
    flex: 1,
    minHeight: 96,
    overflow: "hidden",
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface0,
  },
  columnScroll: {
    flex: 1,
  },
  columnCards: {
    flexGrow: 1,
    minHeight: 96,
    gap: theme.spacing[2],
    padding: theme.spacing[1],
  },
  columnBodyOver: {
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.borderAccent,
  },
  card: {
    position: "relative",
    width: "100%",
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    gap: theme.spacing[1.5],
  },
  cardPressTarget: { gap: theme.spacing[1.5] },
  cardOverlay: {
    backgroundColor: theme.colors.surface2,
    borderColor: theme.colors.borderAccent,
  },
  cardDragSource: {
    opacity: 0.4,
  },
  cardHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  cardHeaderWithMenu: { paddingRight: theme.spacing[6] },
  cardKey: {
    flex: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  menuTrigger: {
    position: "absolute",
    top: theme.spacing[2],
    right: theme.spacing[2],
    width: 24,
    height: 24,
    alignItems: "center",
    justifyContent: "center",
  },
  priority: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    flexShrink: 0,
  },
  priorityDanger: {
    color: theme.colors.statusDanger,
  },
  priorityWarning: {
    color: theme.colors.statusWarning,
  },
  counts: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[3],
  },
  addPlan: {
    alignSelf: "flex-start",
    paddingHorizontal: 0,
  },
  count: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  countText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  cardTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  cardLabels: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[1],
  },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    maxWidth: CHIP_MAX_WIDTH,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.full,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 1,
  },
  chipDot: {
    width: theme.spacing[1.5],
    height: theme.spacing[1.5],
    borderRadius: theme.borderRadius.full,
  },
  chipText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  empty: {
    borderWidth: theme.borderWidth[1],
    borderStyle: "dashed",
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    paddingVertical: theme.spacing[4],
    alignItems: "center",
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
}));
