import { useCallback, useMemo, type ReactElement } from "react";
import { Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { ChevronRight } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { Task } from "@getpaseo/protocol/tasks/types";
import { HostStatusDot } from "@/components/host-status-dot";
import type { AggregatedTaskBoard } from "@/tasks/aggregated-task-boards";
import { formatTaskKey, selectOverviewTasks } from "@/tasks/task-views";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { useTaskExecutionSummaries } from "@/tasks/use-task-execution";
import { TaskExecutionSummary } from "./task-execution-summary";
import type { TaskExecutionSummary as TaskExecutionSummaryModel } from "@/tasks/task-execution";

const ThemedChevronRight = withUnistyles(ChevronRight);
const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export interface TaskBoardOverviewColumnProps {
  board: AggregatedTaskBoard | null;
  project: {
    serverId: string;
    projectId: string;
    projectName: string;
    canOpen: boolean;
  };
  showHostBadge: boolean;
  onOpenProject: (taskId?: string) => void;
}

/**
 * One project's tasks as a single column: what is running first, then what is
 * queued, then what finished. Read-only — dragging belongs to the board, where
 * the columns say what a drop would mean.
 */
export function TaskBoardOverviewColumn({
  board,
  project,
  showHostBadge,
  onOpenProject,
}: TaskBoardOverviewColumnProps): ReactElement {
  const { t } = useTranslation();
  const selection = useMemo(() => selectOverviewTasks(board?.tasks ?? []), [board?.tasks]);
  const executionByTaskId = useTaskExecutionSummaries(project.serverId, selection.tasks);
  const testProjectId = board?.project.id ?? project.projectId;
  const emptyLabel = project.canOpen ? t("tasks.screen.empty") : t("tasks.screen.unsupported");
  const handleOpenBoard = useCallback(() => onOpenProject(), [onOpenProject]);
  const handleOpenTask = useCallback((taskId: string) => onOpenProject(taskId), [onOpenProject]);

  return (
    <View style={styles.column} testID={`task-board-overview-${testProjectId}`}>
      <Pressable
        onPress={handleOpenBoard}
        disabled={!project.canOpen}
        style={styles.header}
        accessibilityRole="button"
        testID={`task-board-overview-open-${testProjectId}`}
      >
        {showHostBadge ? <HostStatusDot serverId={project.serverId} /> : null}
        <Text style={styles.title} numberOfLines={1}>
          {project.projectName}
        </Text>
        <Text style={styles.count}>{selection.totalCount}</Text>
        <ThemedChevronRight size={ICON_SIZE.sm} uniProps={mutedIconMapping} />
      </Pressable>

      <View style={styles.body}>
        {selection.tasks.map((task) => (
          <OverviewTaskCard
            key={task.id}
            prefix={board?.project.prefix ?? ""}
            task={task}
            execution={executionByTaskId.get(task.id)}
            onPress={handleOpenTask}
          />
        ))}
        {selection.hiddenCount > 0 ? (
          <Pressable onPress={handleOpenBoard} style={styles.more} accessibilityRole="button">
            <Text style={styles.moreText}>
              {t("kanban.column.showMore", { count: selection.hiddenCount })}
            </Text>
          </Pressable>
        ) : null}
        {selection.totalCount === 0 ? (
          <Pressable
            onPress={handleOpenBoard}
            disabled={!project.canOpen}
            style={styles.empty}
            accessibilityRole="button"
          >
            <Text style={styles.emptyText}>{emptyLabel}</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

/**
 * A card without a menu. The board is where a task is acted on; here a press
 * opens it, so there is nothing on the card that could do something else.
 */
function OverviewTaskCard({
  prefix,
  task,
  execution,
  onPress,
}: {
  prefix: string;
  task: Task;
  execution: TaskExecutionSummaryModel | undefined;
  onPress: (taskId: string) => void;
}): ReactElement {
  const handlePress = useCallback(() => onPress(task.id), [onPress, task.id]);

  return (
    <Pressable
      onPress={handlePress}
      style={styles.card}
      accessibilityRole="button"
      testID={`task-board-overview-card-${task.id}`}
    >
      <View style={styles.cardHeader}>
        <Text style={styles.cardKey}>{formatTaskKey({ prefix }, task)}</Text>
      </View>
      <Text style={styles.cardTitle} numberOfLines={2}>
        {task.title}
      </Text>
      <TaskExecutionSummary summary={execution} compact />
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  column: {
    width: 296,
    flexShrink: 0,
    gap: theme.spacing[1],
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1.5],
    borderRadius: theme.borderRadius.md,
  },
  title: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  count: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  body: {
    gap: theme.spacing[2],
    padding: theme.spacing[1],
  },
  card: {
    gap: theme.spacing[1],
    padding: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
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
    fontWeight: theme.fontWeight.medium,
  },
  cardTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  more: {
    paddingVertical: theme.spacing[1.5],
    alignItems: "center",
  },
  moreText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  empty: {
    borderWidth: 1,
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
