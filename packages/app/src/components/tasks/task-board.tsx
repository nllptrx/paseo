import { useCallback, useMemo, type ReactElement } from "react";
import { ScrollView, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { Task, TaskLabel, TaskProject, TaskStatus } from "@getpaseo/protocol/tasks/types";
import { TASK_STATUSES } from "@getpaseo/protocol/tasks/types";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useIsCompactFormFactor } from "@/constants/layout";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { formatTaskKey, resolveTaskLabels, visibleBoardStatuses } from "@/tasks/task-views";

export const TASK_STATUS_LABEL_KEYS: Record<TaskStatus, string> = {
  backlog: "tasks.status.backlog",
  todo: "tasks.status.todo",
  in_progress: "tasks.status.inProgress",
  in_review: "tasks.status.inReview",
  done: "tasks.status.done",
  canceled: "tasks.status.canceled",
};

export interface TaskBoardProps {
  tasks: readonly Task[];
  labels: readonly TaskLabel[];
  projectsById: ReadonlyMap<string, TaskProject>;
  onSetStatus: (input: { taskId: string; status: TaskStatus }) => void;
  selectedColumn: TaskStatus;
  onSelectColumn: (status: TaskStatus) => void;
}

/**
 * The same tasks the list shows, arranged by the status you set. Wide layouts
 * get every column at once; a compact one picks one at a time, because five
 * columns on a phone are five columns you cannot read.
 */
export function TaskBoard({
  tasks,
  labels,
  projectsById,
  onSetStatus,
  selectedColumn,
  onSelectColumn,
}: TaskBoardProps): ReactElement {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const statuses = useMemo(() => visibleBoardStatuses(tasks), [tasks]);

  const byStatus = useMemo(() => {
    const map = new Map<TaskStatus, Task[]>(statuses.map((status) => [status, []]));
    for (const task of tasks) {
      map.get(task.status)?.push(task);
    }
    return map;
  }, [statuses, tasks]);

  const handleSelectColumn = useCallback(
    (value: string) => {
      const status = TASK_STATUSES.find((entry) => entry === value);
      if (status) {
        onSelectColumn(status);
      }
    },
    [onSelectColumn],
  );

  const options = useMemo(
    () =>
      statuses.map((status) => ({
        value: status,
        label: t(TASK_STATUS_LABEL_KEYS[status]),
      })),
    [statuses, t],
  );

  if (isCompact) {
    const active = statuses.includes(selectedColumn) ? selectedColumn : statuses[0];
    return (
      <View style={styles.compact} testID="task-board">
        <SegmentedControl
          size="sm"
          value={active ?? "backlog"}
          onValueChange={handleSelectColumn}
          options={options}
          testID="task-board-column-picker"
        />
        {active ? (
          <TaskColumn
            status={active}
            tasks={byStatus.get(active) ?? []}
            labels={labels}
            projectsById={projectsById}
            onSetStatus={onSetStatus}
          />
        ) : null}
      </View>
    );
  }

  return (
    <ScrollView horizontal contentContainerStyle={styles.wideRow} testID="task-board">
      {statuses.map((status) => (
        <TaskColumn
          key={status}
          status={status}
          tasks={byStatus.get(status) ?? []}
          labels={labels}
          projectsById={projectsById}
          onSetStatus={onSetStatus}
        />
      ))}
    </ScrollView>
  );
}

function TaskColumn({
  status,
  tasks,
  labels,
  projectsById,
  onSetStatus,
}: {
  status: TaskStatus;
  tasks: readonly Task[];
  labels: readonly TaskLabel[];
  projectsById: ReadonlyMap<string, TaskProject>;
  onSetStatus: (input: { taskId: string; status: TaskStatus }) => void;
}): ReactElement {
  const { t } = useTranslation();

  return (
    <View style={styles.column} testID={`task-column-${status}`}>
      <View style={styles.columnHeader}>
        <Text style={styles.columnTitle}>{t(TASK_STATUS_LABEL_KEYS[status])}</Text>
        <Text style={styles.columnCount}>{tasks.length}</Text>
      </View>
      <View style={styles.columnBody}>
        {tasks.map((task) => (
          <TaskBoardCard
            key={task.id}
            task={task}
            project={projectsById.get(task.projectId)}
            labels={labels}
            onSetStatus={onSetStatus}
          />
        ))}
        {tasks.length === 0 ? (
          <View style={styles.empty}>
            <Text style={styles.emptyText}>{t("tasks.board.emptyColumn")}</Text>
          </View>
        ) : null}
      </View>
    </View>
  );
}

function TaskBoardCard({
  task,
  project,
  labels,
  onSetStatus,
}: {
  task: Task;
  project: TaskProject | undefined;
  labels: readonly TaskLabel[];
  onSetStatus: (input: { taskId: string; status: TaskStatus }) => void;
}): ReactElement {
  const { t } = useTranslation();
  const taskLabels = resolveTaskLabels(task, labels);

  return (
    <View style={styles.card} testID={`task-card-${task.id}`}>
      <View style={styles.cardHeader}>
        <Text style={styles.cardKey}>{formatTaskKey(project, task)}</Text>
        {/* Derived and live, beside the status you set rather than merged into it. */}
        {task.agents.length > 0 ? <View style={styles.activeDot} /> : null}
        <View style={styles.cardMenu}>
          <DropdownMenu>
            <DropdownMenuTrigger
              testID={`task-card-status-${task.id}`}
              accessibilityRole="button"
              accessibilityLabel={t("tasks.board.changeStatus")}
            >
              <Text style={styles.cardMenuGlyph}>⋯</Text>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="bottom" align="end">
              {TASK_STATUSES.filter((status) => status !== task.status).map((status) => (
                <StatusMenuItem
                  key={status}
                  taskId={task.id}
                  status={status}
                  onSetStatus={onSetStatus}
                />
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </View>
      </View>
      <Text style={styles.cardTitle} numberOfLines={3}>
        {task.title}
      </Text>
      {taskLabels.length > 0 ? (
        <View style={styles.cardLabels}>
          {taskLabels.map((label) => (
            <View key={label.id} style={styles.chipDotOnly}>
              <View style={[styles.chipDot, { backgroundColor: label.color }]} />
              <Text style={styles.chipText} numberOfLines={1}>
                {label.name}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

function StatusMenuItem({
  taskId,
  status,
  onSetStatus,
}: {
  taskId: string;
  status: TaskStatus;
  onSetStatus: (input: { taskId: string; status: TaskStatus }) => void;
}): ReactElement {
  const { t } = useTranslation();
  const handleSelect = useCallback(
    () => onSetStatus({ taskId, status }),
    [onSetStatus, status, taskId],
  );
  return (
    <DropdownMenuItem testID={`task-card-status-${taskId}-${status}`} onSelect={handleSelect}>
      {t(TASK_STATUS_LABEL_KEYS[status])}
    </DropdownMenuItem>
  );
}

const COLUMN_WIDTH = 280;

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
    width: { xs: "100%", md: COLUMN_WIDTH },
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
  columnBody: {
    minHeight: 96,
    gap: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
    padding: theme.spacing[1],
    backgroundColor: theme.colors.surface0,
  },
  card: {
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    gap: theme.spacing[1.5],
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
  cardMenu: {
    width: 20,
    alignItems: "center",
  },
  cardMenuGlyph: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
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
  activeDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: theme.colors.statusSuccess,
  },
  chipDotOnly: {
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
