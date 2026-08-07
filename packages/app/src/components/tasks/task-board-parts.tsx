import { useCallback, useMemo, type ReactElement } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { MoreVertical, Plus } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { Task, TaskLabel, TaskProject, TaskStatus } from "@getpaseo/protocol/tasks/types";
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
import { StatusBucketDot } from "@/components/status-bucket-dot";
import { useWorkspaceStatusesByIds } from "@/stores/session-store-hooks";
import { formatTaskKey, resolveTaskLabels } from "@/tasks/task-views";
import { aggregateSidebarStateBuckets, type SidebarStateBucket } from "@/utils/sidebar-agent-state";
import { ICON_SIZE, type Theme } from "@/styles/theme";

const ThemedMoreVertical = withUnistyles(MoreVertical);
const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const foregroundIconMapping = (theme: Theme) => ({ color: theme.colors.foreground });

interface TaskCardAction {
  key: string;
  label: string;
  testID: string;
  onSelect: () => void;
}

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
  onMoveTask: (move: TaskBoardMove) => void;
  /** The column's own "+" captures straight into that status. */
  onCreateTask: (status: TaskStatus) => void;
  /** A card with work attached opens the conversation doing it. */
  onOpenAgent: (input: { workspaceId: string; agentId: string }) => void;
  /** Authors a plan already attached to the task, when the surface offers one. */
  onCreatePlanForTask?: (taskId: string) => void;
  selectedColumn: TaskStatus;
  onSelectColumn: (status: TaskStatus) => void;
}

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
  tasks,
  labels,
  projectsById,
  onMoveToStatus,
  onCreateTask,
  onOpenAgent,
  onCreatePlanForTask,
  isOver = false,
  renderCard,
  bodyRef,
}: {
  serverId: string;
  status: TaskStatus;
  tasks: readonly Task[];
  labels: readonly TaskLabel[];
  projectsById: ReadonlyMap<string, TaskProject>;
  onMoveToStatus: (input: { taskId: string; status: TaskStatus }) => void;
  onCreateTask: (status: TaskStatus) => void;
  onOpenAgent: (input: { workspaceId: string; agentId: string }) => void;
  onCreatePlanForTask?: ((taskId: string) => void) | undefined;
  isOver?: boolean;
  /** Lets the web board wrap each card in a sortable without forking the column. */
  renderCard?: (task: Task, card: ReactElement) => ReactElement;
  /** Registers the column body as a drop target on web. */
  bodyRef?: (element: never) => void;
}): ReactElement {
  const { t } = useTranslation();
  const handleCreate = useCallback(() => onCreateTask(status), [onCreateTask, status]);

  return (
    <View style={styles.column} testID={`task-column-${status}`}>
      <View style={styles.columnHeader}>
        <Text style={styles.columnTitle}>{t(TASK_STATUS_LABEL_KEYS[status])}</Text>
        <Text style={styles.columnCount}>{tasks.length}</Text>
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
        {tasks.map((task) => {
          const card = (
            <TaskCard
              key={task.id}
              serverId={serverId}
              task={task}
              project={projectsById.get(task.projectId)}
              labels={labels}
              onMoveToStatus={onMoveToStatus}
              onOpenAgent={onOpenAgent}
              onCreatePlanForTask={onCreatePlanForTask}
            />
          );
          return renderCard ? renderCard(task, card) : card;
        })}
        {tasks.length === 0 ? (
          <View style={styles.empty}>
            <Text style={styles.emptyText}>{t("tasks.board.emptyColumn")}</Text>
          </View>
        ) : null}
      </View>
    </View>
  );
}

export function TaskCard({
  serverId,
  task,
  project,
  labels,
  onMoveToStatus,
  onOpenAgent,
  onCreatePlanForTask,
  isOverlay = false,
  isDragSource = false,
}: {
  serverId: string;
  task: Task;
  project: TaskProject | undefined;
  labels: readonly TaskLabel[];
  onMoveToStatus: (input: { taskId: string; status: TaskStatus }) => void;
  onOpenAgent: (input: { workspaceId: string; agentId: string }) => void;
  onCreatePlanForTask?: ((taskId: string) => void) | undefined;
  /** Rendered inside the drag overlay: lifted, non-interactive. */
  isOverlay?: boolean;
  /** The in-column original while its overlay clone is being dragged. */
  isDragSource?: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const taskLabels = resolveTaskLabels(task, labels);
  const workspaceIds = useMemo(() => task.agents.map((link) => link.workspaceId), [task.agents]);
  const statusByWorkspaceId = useWorkspaceStatusesByIds(serverId, workspaceIds);
  // Derived and live, beside the status you set rather than merged into it.
  const bucket = useMemo<SidebarStateBucket | null>(() => {
    if (statusByWorkspaceId.size === 0) {
      return null;
    }
    return aggregateSidebarStateBuckets(statusByWorkspaceId.values());
  }, [statusByWorkspaceId]);
  const singleAgent = task.agents.length === 1 ? task.agents[0] : undefined;
  const handlePress = useCallback(() => {
    if (singleAgent) {
      onOpenAgent({ workspaceId: singleAgent.workspaceId, agentId: singleAgent.agentId });
    }
  }, [onOpenAgent, singleAgent]);

  // One list feeds the kebab and the right-click menu, so a card is reachable
  // the way any other card on this platform is.
  const actions = useMemo<TaskCardAction[]>(() => {
    const entries: TaskCardAction[] = [];
    if (onCreatePlanForTask) {
      entries.push({
        key: "add-plan",
        label: t("kanban.column.addPlan"),
        testID: `task-card-add-plan-${task.id}`,
        onSelect: () => onCreatePlanForTask(task.id),
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
    return entries;
  }, [onCreatePlanForTask, onMoveToStatus, onOpenAgent, t, task.agents, task.id, task.status]);

  const body = (
    <>
      <View style={styles.cardHeader}>
        <Text style={styles.cardKey}>{formatTaskKey(project, task)}</Text>
        {bucket ? <StatusBucketDot bucket={bucket} /> : null}
        {isOverlay ? null : (
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
                  onSelect={action.onSelect}
                >
                  {action.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </View>
      <Text style={styles.cardTitle} numberOfLines={3}>
        {task.title}
      </Text>
      {taskLabels.length > 0 ? (
        <View style={styles.cardLabels}>
          {taskLabels.map((label) => (
            <View key={label.id} style={styles.chip}>
              <View style={[styles.chipDot, { backgroundColor: label.color }]} />
              <Text style={styles.chipText} numberOfLines={1}>
                {label.name}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
    </>
  );

  const cardStyle = [
    styles.card,
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
      <ContextMenuTrigger
        onPress={handlePress}
        style={cardStyle}
        testID={`task-card-${task.id}`}
        accessibilityRole="button"
        enabledOnMobile={false}
      >
        {body}
      </ContextMenuTrigger>
      <ContextMenuContent align="start" width={220} testID={`task-card-context-menu-${task.id}`}>
        {actions.map((action) => (
          <ContextMenuItem
            key={action.key}
            testID={`task-card-context-action-${task.id}-${action.key}`}
            onSelect={action.onSelect}
          >
            {action.label}
          </ContextMenuItem>
        ))}
      </ContextMenuContent>
    </ContextMenu>
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
    minHeight: 96,
    gap: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
    padding: theme.spacing[1],
    backgroundColor: theme.colors.surface0,
  },
  columnBodyOver: {
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.borderAccent,
    padding: theme.spacing[1] - 1,
  },
  card: {
    width: "100%",
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    gap: theme.spacing[1.5],
  },
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
  cardKey: {
    flex: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  menuTrigger: {
    width: 24,
    height: 24,
    alignItems: "center",
    justifyContent: "center",
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
    gap: 4,
    maxWidth: 120,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.full,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 1,
  },
  chipDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
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
