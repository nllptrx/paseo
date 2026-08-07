import { useCallback, useMemo, useState, type ReactElement } from "react";
import { ScrollView, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { ArrowLeft } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { StatusBucketDot } from "@/components/status-bucket-dot";
import { Button } from "@/components/ui/button";
import { useOrchestratorPeers } from "@/hooks/use-orchestrator-peers";
import {
  resolveOrchestratorPeerBucket,
  selectKanbanOrchestrators,
  type AggregatedOrchestratorPeer,
} from "@/kanban/orchestrator-peers";
import { useWorkspaceStatusesByIds } from "@/stores/session-store-hooks";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { OrchestratorRail } from "./orchestrator-rail";
import {
  OrchestratorThreadComposer,
  OrchestratorThreadMessages,
  useOrchestratorPeerThread,
} from "./orchestrator-thread-view";

const ThemedArrowLeft = withUnistyles(ArrowLeft);
const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export interface KanbanOrchestratorPaneProps {
  serverId: string;
  kanbanId: string;
}

/**
 * The board's own Orchestrators, beside the board. A kanban can be steered by
 * several, so the pane is a list first and a conversation second; a board with
 * exactly one skips the list, because there is nothing to choose between.
 */
export function KanbanOrchestratorPane({
  serverId,
  kanbanId,
}: KanbanOrchestratorPaneProps): ReactElement {
  const { t } = useTranslation();
  const { peers: allPeers, isLoading, isError, refetch } = useOrchestratorPeers();
  const peers = useMemo(
    () => selectKanbanOrchestrators(allPeers, { serverId, kanbanId }),
    [allPeers, kanbanId, serverId],
  );

  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const selected =
    peers.find((peer) => peer.agentId === selectedAgentId) ??
    (peers.length === 1 ? peers[0] : null);

  const handleSelectPeer = useCallback(
    (peer: AggregatedOrchestratorPeer) => setSelectedAgentId(peer.agentId),
    [],
  );
  const handleBack = useCallback(() => setSelectedAgentId(null), []);

  const state = useOrchestratorPeerThread({ peer: selected ?? null, enabled: true });

  if (!selected) {
    return (
      <View style={styles.pane} testID="kanban-orchestrator-pane">
        <ScrollView style={styles.scroll}>
          <OrchestratorRail
            peers={peers}
            showHostBadge={false}
            isLoading={isLoading}
            hasError={isError}
            onSelectPeer={handleSelectPeer}
            onRetry={refetch}
            emptyText={t("kanban.orchestrator.pane.empty")}
          />
        </ScrollView>
      </View>
    );
  }

  return (
    <View style={styles.pane} testID="kanban-orchestrator-pane">
      <PaneHeader
        peer={selected}
        onBack={peers.length > 1 ? handleBack : null}
        backLabel={t("kanban.orchestrator.pane.back")}
      />
      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
        <OrchestratorThreadMessages state={state} />
      </ScrollView>
      <View style={styles.footer}>
        <OrchestratorThreadComposer state={state} />
      </View>
    </View>
  );
}

function PaneHeader({
  peer,
  onBack,
  backLabel,
}: {
  peer: AggregatedOrchestratorPeer;
  onBack: (() => void) | null;
  backLabel: string;
}): ReactElement {
  const workspaceIds = useMemo(() => [peer.workspaceId], [peer.workspaceId]);
  const statusByWorkspaceId = useWorkspaceStatusesByIds(peer.serverId, workspaceIds);
  const bucket = resolveOrchestratorPeerBucket({
    liveBucket: statusByWorkspaceId.get(peer.workspaceId),
    agentLastStatus: peer.agentLastStatus,
    attention: peer.attention,
  });

  return (
    <View style={styles.header}>
      {onBack ? (
        <Button
          variant="ghost"
          size="xs"
          onPress={onBack}
          accessibilityLabel={backLabel}
          testID="kanban-orchestrator-pane-back"
        >
          <ThemedArrowLeft size={ICON_SIZE.sm} uniProps={mutedIconMapping} />
        </Button>
      ) : null}
      <StatusBucketDot bucket={bucket} />
      <Text style={styles.headerTitle} numberOfLines={1}>
        {peer.agentTitle ?? peer.kanbanName}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  pane: {
    flex: 1,
    minHeight: 0,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  headerTitle: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  scroll: {
    flex: 1,
    minHeight: 0,
  },
  scrollContent: {
    paddingVertical: theme.spacing[3],
  },
  footer: {
    padding: theme.spacing[3],
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
  },
}));
