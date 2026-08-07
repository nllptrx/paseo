import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { ChatMessage } from "@getpaseo/protocol/chat/types";
import { Button } from "@/components/ui/button";
import { FormTextInput } from "@/components/ui/form-field";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { useOrchestratorThread } from "@/hooks/use-orchestrator-thread";
import type { AggregatedOrchestratorPeer } from "@/kanban/orchestrator-peers";
import { buildOrchestratorMentionPrefix } from "@/kanban/orchestrator-thread";
import { toErrorMessage } from "@/utils/error-messages";

export interface OrchestratorThreadViewState {
  messages: ChatMessage[];
  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
  draft: string;
  setDraft: (value: string) => void;
  canSend: boolean;
  send: () => void;
  isPosting: boolean;
  postError: string | null;
}

/**
 * One conversation with one Orchestrator, wherever it is rendered. The room is
 * per-daemon and shared by every Orchestrator on that host, so addressing is an
 * `@agent-id` mention the daemon turns into a prompt for that agent; the peer's
 * own host is the one the read and the post go to.
 */
export function useOrchestratorPeerThread(input: {
  peer: AggregatedOrchestratorPeer | null;
  enabled: boolean;
}): OrchestratorThreadViewState {
  const { peer, enabled } = input;
  const mentionPrefix = peer ? buildOrchestratorMentionPrefix(peer.agentId) : "";
  const [draft, setDraft] = useState(mentionPrefix);
  const [postError, setPostError] = useState<string | null>(null);
  const { messages, isLoading, isError, refetch, postMessage, isPosting } = useOrchestratorThread({
    serverId: peer?.serverId ?? "",
    enabled: enabled && peer !== null,
  });

  useEffect(() => {
    setDraft(mentionPrefix);
    setPostError(null);
  }, [mentionPrefix]);

  const canSend = draft.trim().length > mentionPrefix.trim().length && !isPosting;

  const send = useCallback(() => {
    const body = draft.trim();
    if (body.length === 0) {
      return;
    }
    setPostError(null);
    void postMessage(body)
      .then(() => setDraft(mentionPrefix))
      .catch((error: unknown) => setPostError(toErrorMessage(error)));
  }, [draft, mentionPrefix, postMessage]);

  return useMemo(
    () => ({
      messages,
      isLoading,
      isError,
      refetch,
      draft,
      setDraft,
      canSend,
      send,
      isPosting,
      postError,
    }),
    [canSend, draft, isError, isLoading, isPosting, messages, postError, refetch, send],
  );
}

export function OrchestratorThreadMessages({
  state,
}: {
  state: OrchestratorThreadViewState;
}): ReactElement {
  const { t } = useTranslation();

  return (
    <View style={styles.body} testID="orchestrator-thread-messages">
      {state.isLoading && state.messages.length === 0 ? (
        <View style={styles.centered}>
          <LoadingSpinner size="small" color={styles.spinner.color} />
        </View>
      ) : null}
      {state.isError && state.messages.length === 0 ? (
        <View style={styles.centered}>
          <Text style={styles.errorText}>{t("kanban.orchestrator.thread.loadError")}</Text>
          <Button
            variant="ghost"
            size="sm"
            onPress={state.refetch}
            testID="orchestrator-thread-retry"
          >
            {t("common.actions.retry")}
          </Button>
        </View>
      ) : null}
      {!state.isLoading && !state.isError && state.messages.length === 0 ? (
        <Text style={styles.emptyText}>{t("kanban.orchestrator.thread.empty")}</Text>
      ) : null}
      {state.messages.map((message) => (
        <View key={message.id} style={styles.message}>
          <Text style={styles.messageAuthor}>{message.authorAgentId}</Text>
          <Text style={styles.messageBody}>{message.body}</Text>
        </View>
      ))}
    </View>
  );
}

export function OrchestratorThreadComposer({
  state,
}: {
  state: OrchestratorThreadViewState;
}): ReactElement {
  const { t } = useTranslation();

  return (
    <View style={styles.composer}>
      <FormTextInput
        value={state.draft}
        onChangeText={state.setDraft}
        placeholder={t("kanban.orchestrator.thread.placeholder")}
        multiline
        testID="orchestrator-thread-input"
      />
      {state.postError ? <Text style={styles.errorText}>{state.postError}</Text> : null}
      <Button
        variant="default"
        onPress={state.send}
        disabled={!state.canSend}
        loading={state.isPosting}
        testID="orchestrator-thread-send"
      >
        {t("kanban.orchestrator.thread.send")}
      </Button>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
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
