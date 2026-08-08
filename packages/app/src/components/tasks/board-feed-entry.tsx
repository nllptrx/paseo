import { useCallback, type ReactElement } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { TaskComment } from "@getpaseo/protocol/tasks/types";

/** Wall-clock time only: a feed you read top to bottom already carries the day. */
export function formatEntryTime(createdAt: string): string {
  const at = new Date(createdAt);
  if (Number.isNaN(at.getTime())) {
    return "";
  }
  return at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/**
 * One feed entry — author, optional card key, time, body. Shared by the
 * board-wide feed pane and the task detail sheet's comments, which read the
 * same `TaskComment` rows filtered to one task.
 */
export function BoardFeedEntryRow({
  entry,
  taskKey,
  onOpenTask,
}: {
  entry: TaskComment;
  taskKey?: string | undefined;
  onOpenTask?: ((taskId: string) => void) | undefined;
}): ReactElement {
  const taskId = entry.taskId;
  const canOpenTask = taskId !== null && onOpenTask !== undefined;
  const handlePress = useCallback(() => {
    if (taskId && onOpenTask) {
      onOpenTask(taskId);
    }
  }, [taskId, onOpenTask]);

  const isSystem = entry.kind === "system";
  return (
    <View style={styles.entry} testID={`board-feed-entry-${entry.id}`}>
      <View style={styles.entryHeader}>
        <Text style={[styles.author, isSystem && styles.authorSystem]} numberOfLines={1}>
          {entry.authorName}
        </Text>
        {taskKey ? (
          <Text
            style={styles.taskKey}
            onPress={canOpenTask ? handlePress : undefined}
            accessibilityRole={canOpenTask ? "button" : undefined}
            testID={`board-feed-entry-task-${entry.id}`}
          >
            {taskKey}
          </Text>
        ) : null}
        <Text style={styles.time}>{formatEntryTime(entry.createdAt)}</Text>
      </View>
      <Text style={[styles.body, isSystem && styles.bodySystem]}>{entry.body}</Text>
    </View>
  );
}

export const styles = StyleSheet.create((theme) => ({
  entry: {
    gap: theme.spacing[1],
  },
  entryHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  author: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
  },
  authorSystem: {
    color: theme.colors.foregroundMuted,
  },
  taskKey: {
    color: theme.colors.accent,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
  },
  time: {
    flex: 1,
    textAlign: "right",
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  body: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  bodySystem: {
    color: theme.colors.foregroundMuted,
    fontStyle: "italic",
  },
}));
