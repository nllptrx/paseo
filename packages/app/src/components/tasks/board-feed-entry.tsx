import { useCallback, type ReactElement } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { TaskComment } from "@getpaseo/protocol/tasks/types";
import { useWorkspace } from "@/stores/session-store-hooks";
import { useSessionStore } from "@/stores/session-store";

/** Wall-clock time only: a feed you read top to bottom already carries the day. */
export function formatEntryTime(createdAt: string): string {
  const at = new Date(createdAt);
  if (Number.isNaN(at.getTime())) {
    return "";
  }
  return at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

export function resolveFeedEntryKind(
  entry: Pick<TaskComment, "kind" | "entryKind">,
): NonNullable<TaskComment["entryKind"]> {
  if (entry.entryKind) return entry.entryKind;
  if (entry.kind === "agent") return "agent_update";
  if (entry.kind === "system") return "system_event";
  return "note";
}

const ENTRY_KIND_LABELS: Record<NonNullable<TaskComment["entryKind"]>, string> = {
  note: "Note",
  agent_update: "Agent update",
  system_event: "System event",
  message: "Message",
};

/**
 * One feed entry — author, optional card key, time, body. Shared by the
 * board-wide feed pane and the task detail sheet's comments, which read the
 * same `TaskComment` rows filtered to one task.
 */
/** An inline key is a small target for a thumb; the app widens these rather
 * than padding the text out of the row it sits in. */
const INLINE_HIT_SLOP = 8;

export function BoardFeedEntryRow({
  entry,
  taskKey,
  onOpenTask,
  serverId,
}: {
  entry: TaskComment;
  taskKey?: string | undefined;
  onOpenTask?: ((taskId: string) => void) | undefined;
  serverId?: string | undefined;
}): ReactElement {
  const taskId = entry.taskId;
  const canOpenTask = taskId !== null && onOpenTask !== undefined;
  const handlePress = useCallback(() => {
    if (taskId && onOpenTask) {
      onOpenTask(taskId);
    }
  }, [taskId, onOpenTask]);

  const isSystem = entry.kind === "system";
  const entryKind = resolveFeedEntryKind(entry);
  return (
    <View style={styles.entry} testID={`board-feed-entry-${entry.id}`}>
      <View style={styles.entryHeader}>
        <Text style={[styles.kind, styles[`kind_${entryKind}`]]}>
          {ENTRY_KIND_LABELS[entryKind]}
        </Text>
        <Text style={[styles.author, isSystem && styles.authorSystem]} numberOfLines={1}>
          {entry.authorName}
        </Text>
        <TaskKey
          taskKey={taskKey}
          testID={`board-feed-entry-task-${entry.id}`}
          onPress={canOpenTask ? handlePress : undefined}
        />
        <Text style={styles.time}>{formatEntryTime(entry.createdAt)}</Text>
      </View>
      <Text style={[styles.body, isSystem && styles.bodySystem]}>{entry.body}</Text>
      {entryKind === "message" && entry.recipients ? (
        <View style={styles.recipients}>
          {entry.recipients.map((recipient) => (
            <MessageRecipientRow
              key={recipient.agentId}
              serverId={serverId}
              recipient={recipient}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}

function MessageRecipientRow({
  serverId,
  recipient,
}: {
  serverId: string | undefined;
  recipient: NonNullable<TaskComment["recipients"]>[number];
}): ReactElement {
  const workspace = useWorkspace(serverId ?? null, recipient.workspaceId ?? null);
  const agent = useSessionStore((state) =>
    serverId ? state.sessions[serverId]?.agents.get(recipient.agentId) : undefined,
  );
  const name = agent?.title ?? workspace?.title ?? workspace?.name ?? agent?.provider ?? "Agent";
  const provider = agent?.provider ? ` · ${agent.provider}` : "";
  return (
    <View style={styles.recipientRow} testID={`board-feed-recipient-${recipient.agentId}`}>
      <Text style={styles.recipientIdentity} numberOfLines={1}>
        To {name}
        {provider} · {recipient.agentId}
      </Text>
      <Text
        style={[styles.delivery, recipient.deliveryStatus === "failed" && styles.deliveryFailed]}
      >
        {recipient.deliveryStatus}
      </Text>
    </View>
  );
}

export /** The card this entry is about. Pressable only when there is a board behind it
 * to open — a key that looks like a link and does nothing is worse than plain
 * text. */
function TaskKey({
  taskKey,
  testID,
  onPress,
}: {
  taskKey: string | undefined;
  testID: string;
  onPress: (() => void) | undefined;
}): ReactElement | null {
  if (!taskKey) {
    return null;
  }
  if (!onPress) {
    return (
      <Text style={styles.taskKey} testID={testID}>
        {taskKey}
      </Text>
    );
  }
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      hitSlop={INLINE_HIT_SLOP}
      testID={testID}
    >
      <Text style={styles.taskKey}>{taskKey}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  entry: {
    gap: theme.spacing[1],
  },
  entryHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  kind: {
    paddingHorizontal: theme.spacing[1],
    paddingVertical: 2,
    borderRadius: theme.borderRadius.sm,
    color: theme.colors.foregroundMuted,
    backgroundColor: theme.colors.surface1,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
  },
  kind_note: {},
  kind_agent_update: {
    color: theme.colors.accent,
  },
  kind_system_event: {
    fontStyle: "italic",
  },
  kind_message: {
    color: theme.colors.foreground,
    backgroundColor: theme.colors.surface2,
  },
  author: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.normal,
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
  recipients: {
    gap: theme.spacing[1],
    paddingTop: theme.spacing[1],
  },
  recipientRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  recipientIdentity: {
    flex: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  delivery: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    textTransform: "capitalize",
  },
  deliveryFailed: {
    color: theme.colors.statusDanger,
  },
}));
