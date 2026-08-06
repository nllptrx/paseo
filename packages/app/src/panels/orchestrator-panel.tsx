import { useCallback, useMemo, useState, type ReactElement } from "react";
import { ScrollView, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { Network } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import invariant from "tiny-invariant";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { KanbanBoardSurface } from "@/components/kanban/kanban-board-surface";
import { OrchestratorRail } from "@/components/kanban/orchestrator-rail";
import { OrchestratorThreadSheet } from "@/components/kanban/orchestrator-thread-sheet";
import { Button } from "@/components/ui/button";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useKanban } from "@/hooks/use-kanbans";
import { useOrchestratorPeers } from "@/hooks/use-orchestrator-peers";
import { useWorkspaceOrchestratorKanban } from "@/hooks/use-workspace-orchestrator-kanban";
import {
  excludeSelfOrchestrator,
  type AggregatedOrchestratorPeer,
} from "@/kanban/orchestrator-peers";
import { usePaneContext } from "@/panels/pane-context";
import type { PanelDescriptor, PanelRegistration } from "@/panels/panel-registry";
import { useHosts } from "@/runtime/host-runtime";

function useOrchestratorPanelDescriptor(
  _target: { kind: "orchestrator" },
  context: { serverId: string; workspaceId: string },
): PanelDescriptor {
  const { t } = useTranslation();
  const { kanban } = useWorkspaceOrchestratorKanban({
    serverId: context.serverId,
    workspaceId: context.workspaceId,
  });
  const label = t("kanban.orchestrator.panel.label");
  const subtitle = kanban?.name ?? label;
  return {
    label,
    subtitle,
    tooltip: subtitle,
    titleState: "ready",
    icon: Network,
    statusBucket: null,
  };
}

function OrchestratorPanel(): ReactElement {
  const { t } = useTranslation();
  const { serverId, workspaceId, target } = usePaneContext();
  invariant(target.kind === "orchestrator", "OrchestratorPanel requires orchestrator target");

  const isCompact = useIsCompactFormFactor();
  const hosts = useHosts();
  const { kanban, isLoading: isResolvingLink } = useWorkspaceOrchestratorKanban({
    serverId,
    workspaceId,
  });
  const {
    kanban: detail,
    isLoading: isLoadingDetail,
    isError,
    error,
    refetch,
  } = useKanban({ serverId, kanbanId: kanban?.id ?? "", enabled: Boolean(kanban) });

  const {
    peers: allPeers,
    isLoading: isLoadingPeers,
    isError: isPeersError,
    refetch: refetchPeers,
  } = useOrchestratorPeers();
  const peers = useMemo(
    () =>
      kanban ? excludeSelfOrchestrator(allPeers, { serverId, kanbanId: kanban.id }) : [...allPeers],
    [allPeers, kanban, serverId],
  );

  const [openPeer, setOpenPeer] = useState<AggregatedOrchestratorPeer | null>(null);
  const [isRailSheetOpen, setIsRailSheetOpen] = useState(false);

  const handleSelectPeer = useCallback((peer: AggregatedOrchestratorPeer) => {
    setIsRailSheetOpen(false);
    setOpenPeer(peer);
  }, []);
  const handleCloseThread = useCallback(() => setOpenPeer(null), []);
  const handleOpenRailSheet = useCallback(() => setIsRailSheetOpen(true), []);
  const handleCloseRailSheet = useCallback(() => setIsRailSheetOpen(false), []);

  const railSheetHeader = useMemo(() => ({ title: t("kanban.orchestrator.rail.heading") }), [t]);

  const rail = (
    <OrchestratorRail
      peers={peers}
      showHostBadge={hosts.length > 1}
      isLoading={isLoadingPeers}
      hasError={isPeersError}
      onSelectPeer={handleSelectPeer}
      onRetry={refetchPeers}
    />
  );

  if (!kanban) {
    return (
      <View style={styles.centered} testID="orchestrator-panel">
        <Text style={styles.emptyText}>
          {isResolvingLink
            ? t("kanban.orchestrator.panel.loading")
            : t("kanban.orchestrator.panel.notLinked")}
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.container} testID="orchestrator-panel">
      <View style={styles.header}>
        <Text style={styles.title} numberOfLines={1}>
          {kanban.name}
        </Text>
        {isCompact ? (
          <Button
            variant="ghost"
            size="sm"
            onPress={handleOpenRailSheet}
            testID="orchestrator-open-rail"
          >
            {t("kanban.orchestrator.rail.heading")}
          </Button>
        ) : null}
      </View>
      <View style={isCompact ? styles.compactBody : styles.wideBody}>
        <ScrollView style={styles.boardScroll} contentContainerStyle={styles.boardScrollContent}>
          <KanbanBoardSurface
            serverId={serverId}
            kanbanId={kanban.id}
            detail={detail}
            isLoading={isLoadingDetail}
            isError={isError}
            error={error}
            onRetry={refetch}
          />
        </ScrollView>
        {isCompact ? null : (
          <ScrollView style={styles.railScroll} testID="orchestrator-rail-scroll">
            {rail}
          </ScrollView>
        )}
      </View>
      {isCompact ? (
        <AdaptiveModalSheet
          header={railSheetHeader}
          visible={isRailSheetOpen}
          onClose={handleCloseRailSheet}
          testID="orchestrator-rail-sheet"
        >
          {rail}
        </AdaptiveModalSheet>
      ) : null}
      {openPeer ? (
        <OrchestratorThreadSheet peer={openPeer} visible onClose={handleCloseThread} />
      ) : null}
    </View>
  );
}

export const orchestratorPanelRegistration: PanelRegistration<"orchestrator"> = {
  kind: "orchestrator",
  component: OrchestratorPanel,
  useDescriptor: useOrchestratorPanelDescriptor,
};

const ORCHESTRATOR_RAIL_WIDTH = 260;

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    minHeight: 0,
    backgroundColor: theme.colors.surface0,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
  },
  title: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  wideBody: {
    flex: 1,
    minHeight: 0,
    flexDirection: "row",
  },
  compactBody: {
    flex: 1,
    minHeight: 0,
  },
  boardScroll: {
    flex: 1,
    minHeight: 0,
  },
  boardScrollContent: {
    flexGrow: 1,
  },
  railScroll: {
    width: ORCHESTRATOR_RAIL_WIDTH,
    minHeight: 0,
    borderLeftWidth: theme.borderWidth[1],
    borderLeftColor: theme.colors.border,
  },
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[6],
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
}));
