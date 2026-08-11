import { useCallback, useMemo, useState, type ReactElement } from "react";
import { Pressable, Text, View } from "react-native";
import {
  Bot,
  Check,
  ChevronDown,
  ChevronUp,
  GitBranch,
  Pencil,
  SendHorizontal,
} from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { TaskComment } from "@getpaseo/protocol/tasks/types";
import { Button } from "@/components/ui/button";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { useWorkspace } from "@/stores/session-store-hooks";
import { useSessionStore } from "@/stores/session-store";
import {
  activityFeedEntryCanCollapse,
  COLLAPSED_FEED_BODY_LINES,
  feedEntryCanCollapse,
  flattenMarkdownForFeed,
  resolveFeedEntryKind,
  resolveTaskActivityBody,
} from "./board-feed-entry.logic";

export { resolveFeedEntryKind } from "./board-feed-entry.logic";

const ThemedSend = withUnistyles(SendHorizontal);
const ThemedPencil = withUnistyles(Pencil);
const ThemedBot = withUnistyles(Bot);
const ThemedGitBranch = withUnistyles(GitBranch);
const ThemedCheck = withUnistyles(Check);

const ACTIVITY_ICON_SIZE = 14;
const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const extraMutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundExtraMuted });
const accentIconMapping = (theme: Theme) => ({ color: theme.colors.accentBright });
const successIconMapping = (theme: Theme) => ({ color: theme.colors.statusSuccess });

/** Wall-clock time only: a feed you read top to bottom already carries the day. */
export function formatEntryTime(createdAt: string): string {
  const at = new Date(createdAt);
  if (Number.isNaN(at.getTime())) {
    return "";
  }
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
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

const ACTIVITY_LINE_HEIGHT = 20;

function resolveDisclosureIcon(isExpanded: boolean): typeof ChevronDown {
  if (isExpanded) return ChevronUp;
  return ChevronDown;
}

export function BoardFeedEntryRow({
  entry,
  taskKey,
  onOpenTask,
  serverId,
  collapsible = false,
  appearance = "standard",
  activityRepeatCount = 1,
  activityFirstCreatedAt,
  activityShowHeader = true,
}: {
  entry: TaskComment;
  taskKey?: string | undefined;
  onOpenTask?: ((taskId: string) => void) | undefined;
  serverId?: string | undefined;
  /** Keeps verbose agent reports from taking over compact task surfaces. */
  collapsible?: boolean | undefined;
  /** Task Activity is a chronological stream, not a stack of feed cards. */
  appearance?: "standard" | "activity" | undefined;
  activityRepeatCount?: number | undefined;
  activityFirstCreatedAt?: string | undefined;
  /** False on entries that continue a same-author run — the run's first entry
   * already named the author. */
  activityShowHeader?: boolean | undefined;
}): ReactElement {
  const [isExpanded, setIsExpanded] = useState(false);
  const taskId = entry.taskId;
  const canOpenTask = taskId !== null && onOpenTask !== undefined;
  const handlePress = useCallback(() => {
    if (taskId && onOpenTask) {
      onOpenTask(taskId);
    }
  }, [taskId, onOpenTask]);

  const isSystem = entry.kind === "system";
  const entryKind = resolveFeedEntryKind(entry);
  const activityBody = useMemo(
    () =>
      appearance === "activity"
        ? flattenMarkdownForFeed(resolveTaskActivityBody(entry))
        : entry.body,
    [appearance, entry],
  );
  const canCollapse =
    collapsible &&
    (appearance === "activity"
      ? activityFeedEntryCanCollapse(activityBody)
      : feedEntryCanCollapse(entry.body));
  const toggleExpanded = useCallback(() => setIsExpanded((current) => !current), []);
  if (appearance === "activity") {
    return (
      <ActivityFeedEntry
        entry={entry}
        body={activityBody}
        entryKind={entryKind}
        serverId={serverId}
        canCollapse={canCollapse}
        isExpanded={isExpanded}
        onToggleExpanded={toggleExpanded}
        repeatCount={activityRepeatCount}
        firstCreatedAt={activityFirstCreatedAt}
        showHeader={activityShowHeader}
      />
    );
  }
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
      <Text
        style={[styles.body, isSystem && styles.bodySystem]}
        numberOfLines={canCollapse && !isExpanded ? COLLAPSED_FEED_BODY_LINES : undefined}
      >
        {entry.body}
      </Text>
      {canCollapse ? (
        <Button
          variant="ghost"
          size="xs"
          leftIcon={resolveDisclosureIcon(isExpanded)}
          onPress={toggleExpanded}
          style={styles.expandButton}
          testID={`board-feed-entry-${entry.id}-expand`}
        >
          {isExpanded ? "Show less" : "Show more"}
        </Button>
      ) : null}
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

function ActivityFeedEntry({
  entry,
  body,
  entryKind,
  serverId,
  canCollapse,
  isExpanded,
  onToggleExpanded,
  repeatCount,
  firstCreatedAt,
  showHeader,
}: {
  entry: TaskComment;
  body: string;
  entryKind: NonNullable<TaskComment["entryKind"]>;
  serverId: string | undefined;
  canCollapse: boolean;
  isExpanded: boolean;
  onToggleExpanded: () => void;
  repeatCount: number;
  firstCreatedAt: string | undefined;
  showHeader: boolean;
}): ReactElement {
  const isSystem = entryKind === "system_event";
  const hasHeader = showHeader && !isSystem;
  const time = formatEntryTime(entry.createdAt);
  const repeatLabel =
    repeatCount > 1 && firstCreatedAt
      ? ` · ×${repeatCount} since ${formatEntryTime(firstCreatedAt)}`
      : null;
  const bodyText = (
    <Text
      style={[styles.activityBody, isSystem && styles.activityBodySystem, styles.activityBodyFlex]}
      numberOfLines={canCollapse && !isExpanded ? 3 : undefined}
    >
      {body}
      {repeatLabel ? <Text style={styles.activityRepeat}>{repeatLabel}</Text> : null}
    </Text>
  );
  const expandControl = canCollapse ? (
    <Pressable
      onPress={onToggleExpanded}
      accessibilityRole="button"
      style={styles.activityExpand}
      testID={`board-feed-entry-${entry.id}-expand`}
    >
      <Text style={styles.activityExpandLabel}>{isExpanded ? "Show less" : "Show more"}</Text>
    </Pressable>
  ) : null;
  const authoredBody = (
    <>
      {bodyText}
      {expandControl}
    </>
  );
  return (
    <View style={styles.activityEntry} testID={`board-feed-entry-${entry.id}`}>
      <View style={styles.activityMarker}>
        <ActivityEntryIcon entryKind={entryKind} />
      </View>
      <View style={styles.activityContent}>
        {hasHeader ? (
          <View style={styles.activityHeader}>
            <Text style={styles.activityAuthor} numberOfLines={1}>
              {entry.authorName}
            </Text>
            <Text style={styles.activityKind}>{ENTRY_KIND_LABELS[entryKind]}</Text>
            <Text style={styles.activityTime}>{time}</Text>
          </View>
        ) : null}
        {hasHeader ? (
          authoredBody
        ) : (
          <View style={styles.activityBodyRow}>
            {bodyText}
            <Text style={styles.activityTime}>{time}</Text>
          </View>
        )}
        {entryKind === "message" && entry.recipients ? (
          <View style={styles.activityRecipients}>
            {entry.recipients.map((recipient) => (
              <MessageRecipientRow
                key={recipient.agentId}
                serverId={serverId}
                recipient={recipient}
                appearance="activity"
              />
            ))}
          </View>
        ) : null}
      </View>
    </View>
  );
}

/** What kind of thing happened, as the one glyph the timeline reads by. */
function ActivityEntryIcon({
  entryKind,
}: {
  entryKind: NonNullable<TaskComment["entryKind"]>;
}): ReactElement {
  if (entryKind === "message") {
    return <ThemedSend size={ACTIVITY_ICON_SIZE} uniProps={accentIconMapping} />;
  }
  if (entryKind === "note") {
    return <ThemedPencil size={ACTIVITY_ICON_SIZE} uniProps={mutedIconMapping} />;
  }
  if (entryKind === "agent_update") {
    return <ThemedBot size={ACTIVITY_ICON_SIZE} uniProps={mutedIconMapping} />;
  }
  return <ThemedGitBranch size={ACTIVITY_ICON_SIZE} uniProps={extraMutedIconMapping} />;
}

function MessageRecipientRow({
  serverId,
  recipient,
  appearance = "standard",
}: {
  serverId: string | undefined;
  recipient: NonNullable<TaskComment["recipients"]>[number];
  appearance?: "standard" | "activity";
}): ReactElement {
  const workspace = useWorkspace(serverId ?? null, recipient.workspaceId ?? null);
  const agent = useSessionStore((state) =>
    serverId ? state.sessions[serverId]?.agents.get(recipient.agentId) : undefined,
  );
  const name = agent?.title ?? workspace?.title ?? workspace?.name ?? agent?.provider ?? "Agent";
  const provider = agent?.provider ? ` · ${agent.provider}` : "";
  const identity =
    appearance === "activity" ? `To ${name}` : `To ${name}${provider} · ${recipient.agentId}`;
  return (
    <View style={styles.recipientRow} testID={`board-feed-recipient-${recipient.agentId}`}>
      <Text
        style={[
          styles.recipientIdentity,
          appearance === "activity" && styles.activityRecipientIdentity,
        ]}
        numberOfLines={1}
      >
        {identity}
      </Text>
      <DeliveryMark status={recipient.deliveryStatus} appearance={appearance} />
    </View>
  );
}

/**
 * Whether the message reached its agent, as one mark: a tick that turns from
 * waiting to delivered. A failure is the only state that earns a word, because
 * it is the only one that asks for something to be done.
 */
function DeliveryMark({
  status,
  appearance,
}: {
  status: NonNullable<TaskComment["recipients"]>[number]["deliveryStatus"];
  appearance: "standard" | "activity";
}): ReactElement {
  if (status === "failed") {
    return (
      <Text style={[styles.delivery, styles.deliveryFailed]} numberOfLines={1}>
        Not delivered
      </Text>
    );
  }
  const mapping = status === "delivered" ? successIconMapping : extraMutedIconMapping;
  return (
    <ThemedCheck
      size={appearance === "activity" ? ACTIVITY_ICON_SIZE : ICON_SIZE.sm}
      uniProps={mapping}
      accessibilityLabel={status === "delivered" ? "Delivered" : "Waiting for delivery"}
    />
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
  expandButton: {
    alignSelf: "flex-start",
    marginLeft: -theme.spacing[2],
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
  deliverySucceeded: {
    color: theme.colors.statusSuccess,
  },
  activityEntry: {
    flexDirection: "row",
    alignItems: "stretch",
    gap: theme.spacing[3],
  },
  activityTime: {
    marginLeft: "auto",
    color: theme.colors.foregroundExtraMuted,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
    lineHeight: ACTIVITY_LINE_HEIGHT,
    textAlign: "right",
  },
  activityBodyRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[2],
  },
  activityBodyFlex: {
    flexShrink: 1,
    flexGrow: 1,
  },
  activityMarker: {
    width: ACTIVITY_ICON_SIZE,
    alignItems: "center",
    paddingTop: theme.spacing[2] + 2,
  },
  activityContent: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing[1],
    paddingVertical: theme.spacing[2],
  },
  activityHeader: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: theme.spacing[2],
  },
  activityAuthor: {
    flexShrink: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    lineHeight: ACTIVITY_LINE_HEIGHT,
  },
  activityKind: {
    color: theme.colors.foregroundExtraMuted,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
  },
  activityBody: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    lineHeight: ACTIVITY_LINE_HEIGHT,
  },
  activityBodySystem: {
    color: theme.colors.foregroundMuted,
  },
  activityExpand: {
    alignSelf: "flex-start",
  },
  activityExpandLabel: {
    color: theme.colors.accentBright,
    fontSize: theme.fontSize.sm,
    lineHeight: ACTIVITY_LINE_HEIGHT,
  },
  activityRepeat: {
    color: theme.colors.foregroundExtraMuted,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
  },
  activityExpandButton: {
    alignSelf: "flex-start",
    // Button xs carries spacing[3] horizontal padding; pull it back so the
    // label ink sits on the content rail.
    marginLeft: -theme.spacing[3],
  },
  activityExpandButtonInset: {
    alignSelf: "flex-start",
  },
  activityRecipients: {
    gap: theme.spacing[1],
    paddingTop: theme.spacing[1],
  },
  activityRecipientIdentity: {
    fontFamily: theme.fontFamily.mono,
    color: theme.colors.foregroundExtraMuted,
  },
  activityDelivery: {
    fontFamily: theme.fontFamily.mono,
  },
}));
