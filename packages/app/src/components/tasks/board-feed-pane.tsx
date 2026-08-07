import { useCallback, useMemo, useState, type ReactElement } from "react";
import { ScrollView, Text, TextInput, View } from "react-native";
import { useTranslation } from "react-i18next";
import { SendHorizontal } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import type { Task, TaskComment, TaskProject } from "@getpaseo/protocol/tasks/types";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { useToast } from "@/contexts/toast-context";
import { formatTaskKey } from "@/tasks/task-views";
import { useBoardFeed, useBoardFeedComposer } from "@/tasks/use-board-feed";
import { toErrorMessage } from "@/utils/error-messages";

export interface BoardFeedPaneProps {
  serverId: string;
  project: TaskProject;
  tasks: readonly Task[];
  /** Opens the card an entry is about. */
  onOpenTask?: (taskId: string) => void;
}

/**
 * Everything happening on this board, oldest at the top: agents' comments, the
 * moves the board made and why, and what you type here. One channel rather than
 * a conversation per agent — which agent said something is a property of the
 * entry, not a reason to split the room.
 */
export function BoardFeedPane({
  serverId,
  project,
  tasks,
  onOpenTask,
}: BoardFeedPaneProps): ReactElement {
  const { t } = useTranslation();
  const toast = useToast();
  const { entries, isLoading, isError, refetch } = useBoardFeed({
    serverId,
    projectId: project.id,
  });
  const { post, isPosting } = useBoardFeedComposer({ serverId, projectId: project.id });
  const [draft, setDraft] = useState("");

  const keyByTaskId = useMemo(() => {
    const byId = new Map<string, string>();
    for (const task of tasks) {
      byId.set(task.id, formatTaskKey(project, task));
    }
    return byId;
  }, [project, tasks]);

  const handleSend = useCallback(() => {
    const body = draft.trim();
    if (body.length === 0 || isPosting) {
      return;
    }
    setDraft("");
    void post({ body }).catch((error) => {
      setDraft(body);
      toast.show(toErrorMessage(error));
    });
  }, [draft, isPosting, post, toast]);

  return (
    <View style={styles.pane} testID="board-feed-pane">
      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
        {isLoading && entries.length === 0 ? (
          <View style={styles.centered}>
            <LoadingSpinner size="small" color={styles.spinner.color} />
          </View>
        ) : null}
        {isError && entries.length === 0 ? (
          <View style={styles.centered}>
            <Text style={styles.mutedText}>{t("tasks.feed.loadError")}</Text>
            <Button variant="ghost" size="sm" onPress={refetch} testID="board-feed-retry">
              {t("common.actions.retry")}
            </Button>
          </View>
        ) : null}
        {!isLoading && !isError && entries.length === 0 ? (
          <View style={styles.centered}>
            <Text style={styles.mutedText}>{t("tasks.feed.empty")}</Text>
          </View>
        ) : null}
        {entries.map((entry) => (
          <FeedEntryRow
            key={entry.id}
            entry={entry}
            taskKey={entry.taskId ? keyByTaskId.get(entry.taskId) : undefined}
            onOpenTask={onOpenTask}
          />
        ))}
      </ScrollView>

      <View style={styles.composer}>
        <TextInput
          value={draft}
          onChangeText={setDraft}
          onSubmitEditing={handleSend}
          placeholder={t("tasks.feed.composerPlaceholder")}
          placeholderTextColor={styles.placeholder.color}
          style={styles.input}
          multiline
          testID="board-feed-composer-input"
        />
        <Button
          variant="ghost"
          size="sm"
          leftIcon={SendHorizontal}
          onPress={handleSend}
          disabled={draft.trim().length === 0 || isPosting}
          accessibilityLabel={t("tasks.feed.send")}
          testID="board-feed-send"
        />
      </View>
    </View>
  );
}

function FeedEntryRow({
  entry,
  taskKey,
  onOpenTask,
}: {
  entry: TaskComment;
  taskKey: string | undefined;
  onOpenTask: ((taskId: string) => void) | undefined;
}): ReactElement {
  const handlePress = useCallback(() => {
    if (entry.taskId && onOpenTask) {
      onOpenTask(entry.taskId);
    }
  }, [entry.taskId, onOpenTask]);

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
            onPress={handlePress}
            accessibilityRole={onOpenTask ? "button" : undefined}
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

/** Wall-clock time only: a feed you read top to bottom already carries the day. */
function formatEntryTime(createdAt: string): string {
  const at = new Date(createdAt);
  if (Number.isNaN(at.getTime())) {
    return "";
  }
  return at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

const styles = StyleSheet.create((theme) => ({
  pane: {
    flex: 1,
    minHeight: 0,
  },
  scroll: {
    flex: 1,
    minHeight: 0,
  },
  scrollContent: {
    padding: theme.spacing[3],
    gap: theme.spacing[3],
  },
  centered: {
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[6],
  },
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
  composer: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: theme.spacing[2],
    padding: theme.spacing[2],
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
  },
  input: {
    flex: 1,
    maxHeight: 120,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface1,
  },
  placeholder: {
    color: theme.colors.foregroundMuted,
  },
  mutedText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  spinner: {
    color: theme.colors.foregroundMuted,
  },
}));
