import { useCallback, useMemo, useState, type ReactElement } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useTranslation } from "react-i18next";
import { SendHorizontal } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import type { Task, TaskProject } from "@getpaseo/protocol/tasks/types";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { useToast } from "@/contexts/toast-context";
import { formatTaskKey } from "@/tasks/task-views";
import { useBoardFeed, useBoardFeedComposer } from "@/tasks/use-board-feed";
import {
  applyMention,
  collectMentionCandidates,
  filterMentionCandidates,
  findActiveMention,
  type FeedMentionCandidate,
} from "@/tasks/feed-mention-model";
import { toErrorMessage } from "@/utils/error-messages";
import { BoardFeedEntryRow } from "./board-feed-entry";

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
  const [caret, setCaret] = useState(0);

  const keyByTaskId = useMemo(() => {
    const byId = new Map<string, string>();
    for (const task of tasks) {
      byId.set(task.id, formatTaskKey(project, task));
    }
    return byId;
  }, [project, tasks]);

  const mentionCandidates = useMemo(
    () => collectMentionCandidates({ tasks, taskKeyById: keyByTaskId }),
    [keyByTaskId, tasks],
  );
  const activeMention = useMemo(() => findActiveMention(draft, caret), [caret, draft]);
  const mentionMatches = useMemo(
    () => (activeMention ? filterMentionCandidates(mentionCandidates, activeMention.term) : []),
    [activeMention, mentionCandidates],
  );

  const handleSelectionChange = useCallback(
    (event: { nativeEvent: { selection: { start: number } } }) => {
      setCaret(event.nativeEvent.selection.start);
    },
    [],
  );
  const handleChangeDraft = useCallback((value: string) => {
    setDraft(value);
  }, []);
  const handlePickMention = useCallback(
    (agentId: string) => {
      if (!activeMention) {
        return;
      }
      const next = applyMention({ body: draft, mention: activeMention, agentId });
      setDraft(next.body);
      setCaret(next.caret);
    },
    [activeMention, draft],
  );

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
          <BoardFeedEntryRow
            key={entry.id}
            entry={entry}
            taskKey={entry.taskId ? keyByTaskId.get(entry.taskId) : undefined}
            onOpenTask={onOpenTask}
          />
        ))}
      </ScrollView>

      {activeMention && mentionMatches.length > 0 ? (
        <View style={styles.mentions} testID="board-feed-mentions">
          {mentionMatches.map((candidate) => (
            <MentionOption
              key={candidate.agentId}
              candidate={candidate}
              onPick={handlePickMention}
            />
          ))}
        </View>
      ) : null}

      <View style={styles.composer}>
        <TextInput
          value={draft}
          onChangeText={handleChangeDraft}
          onSelectionChange={handleSelectionChange}
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

/** An agent is named by the card it is on: two hex ids on one board tell you
 * nothing, and what someone is working is what you meant to pick. */
function MentionOption({
  candidate,
  onPick,
}: {
  candidate: FeedMentionCandidate;
  onPick: (agentId: string) => void;
}): ReactElement {
  const handlePress = useCallback(() => onPick(candidate.agentId), [candidate.agentId, onPick]);
  return (
    <Pressable
      onPress={handlePress}
      style={styles.mentionOption}
      accessibilityRole="button"
      testID={`board-feed-mention-${candidate.agentId}`}
    >
      <Text style={styles.mentionKey}>{candidate.taskKey}</Text>
      <Text style={styles.mentionTitle} numberOfLines={1}>
        {candidate.taskTitle}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  mentions: {
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
    paddingVertical: theme.spacing[1],
  },
  mentionOption: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  mentionKey: {
    color: theme.colors.accent,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
  },
  mentionTitle: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
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
