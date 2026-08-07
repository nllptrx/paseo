import { useMemo, type ReactElement } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { StatusBucketDot } from "@/components/status-bucket-dot";
import { STATUS_BUCKET_LABELS } from "@/hooks/sidebar-status-view-model";
import {
  resolveOrchestratorPeerBucket,
  type AggregatedOrchestratorPeer,
} from "@/kanban/orchestrator-peers";
import { useWorkspaceStatusesByIds } from "@/stores/session-store-hooks";
import {
  OrchestratorThreadComposer,
  OrchestratorThreadMessages,
  useOrchestratorPeerThread,
} from "./orchestrator-thread-view";

export interface OrchestratorThreadSheetProps {
  peer: AggregatedOrchestratorPeer;
  visible: boolean;
  onClose: () => void;
}

/** The shared Orchestrators thread as a sheet, for surfaces with no room to keep
 * a conversation open beside them. */
export function OrchestratorThreadSheet({
  peer,
  visible,
  onClose,
}: OrchestratorThreadSheetProps): ReactElement {
  const state = useOrchestratorPeerThread({ peer, enabled: visible });

  const workspaceIds = useMemo(() => [peer.workspaceId], [peer.workspaceId]);
  const statusByWorkspaceId = useWorkspaceStatusesByIds(peer.serverId, workspaceIds);
  const bucket = resolveOrchestratorPeerBucket({
    liveBucket: statusByWorkspaceId.get(peer.workspaceId),
    agentLastStatus: peer.agentLastStatus,
    attention: peer.attention,
  });

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

  const footer = useMemo(() => <OrchestratorThreadComposer state={state} />, [state]);

  return (
    <AdaptiveModalSheet
      header={header}
      visible={visible}
      onClose={onClose}
      footer={footer}
      testID="orchestrator-thread-sheet"
    >
      <OrchestratorThreadMessages state={state} />
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
}));
