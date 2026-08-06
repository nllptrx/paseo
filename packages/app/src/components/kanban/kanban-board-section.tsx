import { useCallback, useState, type ReactElement } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { MoreVertical } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { HostStatusDot } from "@/components/host-status-dot";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import type { AggregatedKanban } from "@/kanban/aggregated-kanbans";
import { useKanbanDetail } from "@/hooks/use-kanban-detail";
import { useKanbanMutations } from "@/hooks/use-kanban-mutations";
import { useProjectDisplayName } from "@/stores/session-store-hooks";
import { KanbanBoardSurface } from "./kanban-board-surface";

const ThemedMoreVertical = withUnistyles(MoreVertical);
const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const foregroundIconMapping = (theme: Theme) => ({ color: theme.colors.foreground });

export interface KanbanBoardSectionProps {
  kanban: AggregatedKanban;
  showHostBadge: boolean;
}

export function KanbanBoardSection({
  kanban,
  showHostBadge,
}: KanbanBoardSectionProps): ReactElement {
  const { t } = useTranslation();
  const { serverId } = kanban;
  const {
    kanban: detail,
    isLoading,
    isError,
    error,
    refetch,
  } = useKanbanDetail(serverId, kanban.id);
  const { provisionOrchestrator } = useKanbanMutations({ serverId });
  const projectName = useProjectDisplayName(serverId, kanban.projectId);

  const [isProvisioning, setIsProvisioning] = useState(false);

  const handleProvisionOrchestrator = useCallback(async () => {
    setIsProvisioning(true);
    try {
      await provisionOrchestrator({ kanbanId: kanban.id });
    } finally {
      setIsProvisioning(false);
    }
  }, [kanban.id, provisionOrchestrator]);

  return (
    <View style={styles.section} testID={`kanban-board-${kanban.id}`}>
      <View style={styles.header}>
        <View style={styles.headerTitles}>
          {showHostBadge ? <HostStatusDot serverId={serverId} /> : null}
          <Text style={styles.title}>{projectName ?? kanban.name}</Text>
          <Text style={styles.subtitle}>{kanban.name}</Text>
        </View>
        <DropdownMenu>
          <DropdownMenuTrigger
            style={styles.menuTrigger}
            testID={`kanban-board-menu-${kanban.id}`}
            accessibilityRole="button"
            accessibilityLabel={t("kanban.board.menu")}
          >
            {({ hovered }) => (
              <ThemedMoreVertical
                size={ICON_SIZE.sm}
                uniProps={hovered ? foregroundIconMapping : mutedIconMapping}
              />
            )}
          </DropdownMenuTrigger>
          <DropdownMenuContent
            side="bottom"
            align="end"
            testID={`kanban-board-menu-content-${kanban.id}`}
          >
            {kanban.orchestrator ? null : (
              <DropdownMenuItem
                testID={`kanban-create-orchestrator-${kanban.id}`}
                onSelect={handleProvisionOrchestrator}
                disabled={isProvisioning}
              >
                {t("kanban.board.createOrchestrator")}
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </View>

      <KanbanBoardSurface
        serverId={serverId}
        kanbanId={kanban.id}
        detail={detail}
        isLoading={isLoading}
        isError={isError}
        error={error}
        onRetry={refetch}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  section: {
    gap: theme.spacing[2],
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing[4],
  },
  headerTitles: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: theme.spacing[2],
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  subtitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  menuTrigger: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
  },
}));
