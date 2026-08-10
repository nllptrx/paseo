import { useCallback, useMemo, type ReactElement } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { ChevronRight } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { Task, TaskProject } from "@getpaseo/protocol/tasks/types";
import { useCompactTimeAgo } from "@/hooks/use-compact-time-ago";
import { resolveProviderLabel } from "@/tasks/use-task-available-providers";
import {
  TASK_EXECUTION_STATE_LABELS,
  type TaskExecutionEntry,
  type TaskExecutionSummary,
} from "@/tasks/task-execution";
import { buildTaskThreadGroups, type TaskThreadGroup } from "@/tasks/task-threads-view";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { TASK_STATUS_LABEL_KEYS } from "./task-board-parts";
import { TaskExecutionStateDot } from "./task-execution-summary";

const ThemedChevronRight = withUnistyles(ChevronRight);
const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export interface TaskThreadsProps {
  tasks: readonly Task[];
  projectsById: ReadonlyMap<string, TaskProject>;
  executionByTaskId: ReadonlyMap<string, TaskExecutionSummary>;
  untracked: readonly TaskExecutionEntry[];
  onOpenAgent: (input: { workspaceId: string; agentId: string }) => void;
  /** The group heading opens the task it names; the untracked group has none. */
  onOpenTask: (taskId: string) => void;
}

/**
 * The third projection of the same board data: every attached agent and every
 * unclaimed chat as one live list, newest activity first. The columns say where
 * work sits, this says what is running.
 */
export function TaskThreads({
  tasks,
  projectsById,
  executionByTaskId,
  untracked,
  onOpenAgent,
  onOpenTask,
}: TaskThreadsProps): ReactElement {
  const { t } = useTranslation();
  const groups = useMemo(
    () =>
      buildTaskThreadGroups({
        tasks,
        projectsById,
        executionByTaskId,
        untracked,
        untrackedTitle: t("tasks.threads.untracked"),
      }),
    [executionByTaskId, projectsById, t, tasks, untracked],
  );

  if (groups.length === 0) {
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyText}>{t("tasks.threads.empty")}</Text>
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.list} testID="task-threads">
      {groups.map((group) => (
        <ThreadGroup
          key={group.id}
          group={group}
          onOpenAgent={onOpenAgent}
          onOpenTask={onOpenTask}
        />
      ))}
    </ScrollView>
  );
}

function ThreadGroup({
  group,
  onOpenAgent,
  onOpenTask,
}: {
  group: TaskThreadGroup;
  onOpenAgent: TaskThreadsProps["onOpenAgent"];
  onOpenTask: TaskThreadsProps["onOpenTask"];
}): ReactElement {
  const { t } = useTranslation();
  const { taskId } = group;
  const handleOpenTask = useCallback(() => {
    if (taskId) onOpenTask(taskId);
  }, [onOpenTask, taskId]);

  return (
    <View style={styles.group} testID={`task-threads-group-${group.id}`}>
      <Pressable
        onPress={handleOpenTask}
        disabled={taskId === null}
        accessibilityRole={taskId === null ? "header" : "button"}
        style={styles.groupHeader}
      >
        {group.taskKey ? <Text style={styles.groupKey}>{group.taskKey}</Text> : null}
        <Text style={styles.groupTitle} numberOfLines={1}>
          {group.title}
        </Text>
        {group.status ? (
          <Text style={styles.groupStatus}>{t(TASK_STATUS_LABEL_KEYS[group.status])}</Text>
        ) : null}
        <Text style={styles.groupCount}>{group.rows.length}</Text>
      </Pressable>
      <View style={styles.rows}>
        {group.rows.map((row, index) => (
          <ThreadRow key={row.agentId} row={row} separated={index > 0} onOpenAgent={onOpenAgent} />
        ))}
      </View>
    </View>
  );
}

function ThreadRow({
  row,
  separated,
  onOpenAgent,
}: {
  row: TaskExecutionEntry;
  separated: boolean;
  onOpenAgent: TaskThreadsProps["onOpenAgent"];
}): ReactElement {
  const { t } = useTranslation();
  const providerLabel = resolveProviderLabel(row.provider);
  const name = row.title?.trim() || providerLabel;
  const lastUpdate = useCompactTimeAgo(row.updatedAtMs === null ? null : new Date(row.updatedAtMs));
  const detail = [
    row.model ? `${providerLabel} · ${row.model}` : providerLabel,
    row.role === "reviewer" ? t("tasks.detail.reviewerBadge") : null,
    TASK_EXECUTION_STATE_LABELS[row.state],
    row.workspaceName,
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");
  const handlePress = useCallback(
    () => onOpenAgent({ workspaceId: row.workspaceId, agentId: row.agentId }),
    [onOpenAgent, row.agentId, row.workspaceId],
  );

  return (
    <Pressable
      onPress={handlePress}
      accessibilityRole="button"
      style={[styles.row, separated ? styles.rowBorder : null]}
      testID={`task-threads-row-${row.agentId}`}
    >
      <TaskExecutionStateDot state={row.state} />
      <View style={styles.rowContent}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {name}
        </Text>
        <Text style={styles.rowDetail} numberOfLines={1}>
          {detail}
        </Text>
      </View>
      {lastUpdate.length > 0 ? <Text style={styles.rowTime}>{lastUpdate}</Text> : null}
      <ThemedChevronRight size={ICON_SIZE.sm} uniProps={mutedIconMapping} />
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  list: {
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[3],
  },
  empty: {
    alignItems: "center",
    padding: theme.spacing[6],
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  group: {
    gap: theme.spacing[1],
  },
  groupHeader: {
    minWidth: 0,
    flexDirection: "row",
    alignItems: "baseline",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[1],
  },
  groupKey: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontVariant: ["tabular-nums"],
  },
  groupTitle: {
    minWidth: 0,
    flexShrink: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  groupStatus: {
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.xs,
  },
  groupCount: {
    marginLeft: "auto",
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  rows: {
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface1,
    overflow: "hidden",
  },
  row: {
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  rowBorder: {
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
  },
  rowContent: {
    minWidth: 0,
    flex: 1,
    gap: theme.spacing[0.5],
  },
  rowTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  rowDetail: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  rowTime: {
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.xs,
    fontVariant: ["tabular-nums"],
  },
}));
