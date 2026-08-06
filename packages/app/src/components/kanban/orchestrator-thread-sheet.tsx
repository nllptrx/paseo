import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { StatusBucketDot } from "@/components/status-bucket-dot";
import { Button } from "@/components/ui/button";
import { FormTextInput } from "@/components/ui/form-field";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { useOrchestratorThread } from "@/hooks/use-orchestrator-thread";
import { STATUS_BUCKET_LABELS } from "@/hooks/sidebar-status-view-model";
import {
  resolveOrchestratorPeerBucket,
  type AggregatedOrchestratorPeer,
} from "@/kanban/orchestrator-peers";
import { buildOrchestratorMentionPrefix } from "@/kanban/orchestrator-thread";
import { useWorkspaceStatusesByIds } from "@/stores/session-store-hooks";
import { toErrorMessage } from "@/utils/error-messages";

export interface OrchestratorThreadSheetProps {
  peer: AggregatedOrchestratorPeer;
  visible: boolean;
  onClose: () => void;
}

/**
 * The shared Orchestrators thread, opened against the peer's own host: the room
 * is per-daemon, so a message only reaches an Orchestrator through the daemon it
 * runs on. Addressing is an `@agent-id` mention, which the daemon turns into a
 * prompt for that agent.
 */
export function OrchestratorThreadSheet({
  peer,
  visible,
  onClose,
}: OrchestratorThreadSheetProps): ReactElement {
  const { t } = useTranslation();
  const mentionPrefix = buildOrchestratorMentionPrefix(peer.agentId);
  const [draft, setDraft] = useState(mentionPrefix);
  const [postError, setPostError] = useState<string | null>(null);
  const { messages, isLoading, isError, refetch, postMessage, isPosting } = useOrchestratorThread({
    serverId: peer.serverId,
    enabled: visible,
  });

  useEffect(() => {
    setDraft(mentionPrefix);
    setPostError(null);
  }, [mentionPrefix]);

  const workspaceIds = useMemo(() => [peer.workspaceId], [peer.workspaceId]);
  const statusByWorkspaceId = useWorkspaceStatusesByIds(peer.serverId, workspaceIds);
  const bucket = resolveOrchestratorPeerBucket({
    liveBucket: statusByWorkspaceId.get(peer.workspaceId),
    agentLastStatus: peer.agentLastStatus,
    attention: peer.attention,
  });

  const canSend = draft.trim().length > mentionPrefix.trim().length && !isPosting;

  const handleSend = useCallback(async () => {
    const body = draft.trim();
    if (body.length === 0) {
      return;
    }
    setPostError(null);
    try {
      await postMessage(body);
      setDraft(mentionPrefix);
    } catch (error) {
      setPostError(toErrorMessage(error));
    }
  }, [draft, mentionPrefix, postMessage]);

  const header = useMemo(
    () => ({
      title: peer.kanbanName,
      subtitle: (
        <View style={styles.subtitleRow}>
          <StatusBucketDot bucket={bucket} />
          <Text style={styles.subtitleText}>
            {STATUS_BUCKET_LABELS[bucket]}
            {" · "}
            {peer.serverName}
          </Text>
        </View>
      ),
    }),
    [bucket, peer.kanbanName, peer.serverName],
  );

  const footer = useMemo(
    () => (
      <View style={styles.composer}>
        <FormTextInput
          value={draft}
          onChangeText={setDraft}
          placeholder={t("kanban.orchestrator.thread.placeholder")}
          multiline
          testID="orchestrator-thread-input"
        />
        {postError ? <Text style={styles.errorText}>{postError}</Text> : null}
        <Button
          variant="default"
          onPress={handleSend}
          disabled={!canSend}
          loading={isPosting}
          testID="orchestrator-thread-send"
        >
          {t("kanban.orchestrator.thread.send")}
        </Button>
      </View>
    ),
    [canSend, draft, handleSend, isPosting, postError, t],
  );

  return (
    <AdaptiveModalSheet
      header={header}
      visible={visible}
      onClose={onClose}
      footer={footer}
      testID="orchestrator-thread-sheet"
    >
      <View style={styles.body}>
        {isLoading && messages.length === 0 ? (
          <View style={styles.centered}>
            <LoadingSpinner size="small" color={styles.spinner.color} />
          </View>
        ) : null}
        {isError && messages.length === 0 ? (
          <View style={styles.centered}>
            <Text style={styles.errorText}>{t("kanban.orchestrator.thread.loadError")}</Text>
            <Button variant="ghost" size="sm" onPress={refetch} testID="orchestrator-thread-retry">
              {t("common.actions.retry")}
            </Button>
          </View>
        ) : null}
        {!isLoading && !isError && messages.length === 0 ? (
          <Text style={styles.emptyText}>{t("kanban.orchestrator.thread.empty")}</Text>
        ) : null}
        {messages.map((message) => (
          <View key={message.id} style={styles.message}>
            <Text style={styles.messageAuthor}>{message.authorAgentId}</Text>
            <Text style={styles.messageBody}>{message.body}</Text>
          </View>
        ))}
      </View>
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  subtitleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  subtitleText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  body: {
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
  },
  message: {
    gap: theme.spacing[1],
  },
  messageAuthor: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  messageBody: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  composer: {
    gap: theme.spacing[2],
  },
  centered: {
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[4],
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  errorText: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.xs,
    textAlign: "center",
  },
  spinner: {
    color: theme.colors.foregroundMuted,
  },
}));
