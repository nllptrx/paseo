import { useCallback, useMemo, type ReactElement } from "react";
import { Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { HostStatusDot } from "@/components/host-status-dot";
import { StatusBucketDot } from "@/components/status-bucket-dot";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import {
  resolveOrchestratorPeerBucket,
  type AggregatedOrchestratorPeer,
} from "@/kanban/orchestrator-peers";
import { useProjectDisplayName, useWorkspaceStatusesByIds } from "@/stores/session-store-hooks";

export interface OrchestratorRailProps {
  peers: readonly AggregatedOrchestratorPeer[];
  showHostBadge: boolean;
  isLoading: boolean;
  onSelectPeer: (peer: AggregatedOrchestratorPeer) => void;
  onRetry: () => void;
  hasError: boolean;
}

/**
 * Lists the other Orchestrators this client can reach. Rows are pressable and
 * hand off to the shared Orchestrators thread — the rail itself holds no chat state.
 */
export function OrchestratorRail({
  peers,
  showHostBadge,
  isLoading,
  onSelectPeer,
  onRetry,
  hasError,
}: OrchestratorRailProps): ReactElement {
  const { t } = useTranslation();

  return (
    <View style={styles.rail} testID="orchestrator-rail">
      <Text style={styles.heading}>{t("kanban.orchestrator.rail.heading")}</Text>
      {isLoading && peers.length === 0 ? (
        <View style={styles.centered}>
          <LoadingSpinner size="small" color={styles.spinner.color} />
        </View>
      ) : null}
      {hasError && peers.length === 0 ? (
        <View style={styles.centered}>
          <Text style={styles.errorText}>{t("kanban.orchestrator.rail.loadError")}</Text>
          <Button variant="ghost" size="sm" onPress={onRetry} testID="orchestrator-rail-retry">
            {t("common.actions.retry")}
          </Button>
        </View>
      ) : null}
      {!isLoading && !hasError && peers.length === 0 ? (
        <Text style={styles.emptyText}>{t("kanban.orchestrator.rail.empty")}</Text>
      ) : null}
      {peers.map((peer) => (
        <OrchestratorRailRow
          key={`${peer.serverId}:${peer.kanbanId}`}
          peer={peer}
          showHostBadge={showHostBadge}
          onSelect={onSelectPeer}
        />
      ))}
    </View>
  );
}

function OrchestratorRailRow({
  peer,
  showHostBadge,
  onSelect,
}: {
  peer: AggregatedOrchestratorPeer;
  showHostBadge: boolean;
  onSelect: (peer: AggregatedOrchestratorPeer) => void;
}): ReactElement {
  const { t } = useTranslation();
  const projectName = useProjectDisplayName(peer.serverId, peer.projectId);
  const workspaceIds = useMemo(() => [peer.workspaceId], [peer.workspaceId]);
  const statusByWorkspaceId = useWorkspaceStatusesByIds(peer.serverId, workspaceIds);
  const bucket = resolveOrchestratorPeerBucket({
    liveBucket: statusByWorkspaceId.get(peer.workspaceId),
    agentLastStatus: peer.agentLastStatus,
    attention: peer.attention,
  });

  const handlePress = useCallback(() => onSelect(peer), [onSelect, peer]);

  return (
    <Pressable
      onPress={handlePress}
      style={styles.row}
      testID={`orchestrator-rail-peer-${peer.kanbanId}`}
      accessibilityRole="button"
      accessibilityLabel={t("kanban.orchestrator.rail.openThread", { name: peer.kanbanName })}
    >
      <View style={styles.rowTitles}>
        {showHostBadge ? <HostStatusDot serverId={peer.serverId} /> : null}
        <Text style={styles.rowTitle} numberOfLines={1}>
          {projectName ?? peer.kanbanName}
        </Text>
      </View>
      <View style={styles.rowMeta}>
        <Text style={styles.rowSubtitle} numberOfLines={1}>
          {showHostBadge ? `${peer.serverName} · ${peer.kanbanName}` : peer.kanbanName}
        </Text>
        <StatusBucketDot bucket={bucket} />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  rail: {
    gap: theme.spacing[2],
    padding: theme.spacing[3],
  },
  heading: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
  },
  row: {
    gap: theme.spacing[1],
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  rowTitles: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  rowTitle: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  rowMeta: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  rowSubtitle: {
    flex: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  centered: {
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[4],
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
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
