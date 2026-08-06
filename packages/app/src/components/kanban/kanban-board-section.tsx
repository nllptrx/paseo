import { useCallback, useMemo, useState, type ReactElement } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { MoreVertical } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { StoredKanban } from "@getpaseo/protocol/kanban/types";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { HostStatusDot } from "@/components/host-status-dot";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import type { AggregatedKanban } from "@/kanban/aggregated-kanbans";
import { useKanbanDetail } from "@/hooks/use-kanban-detail";
import { useKanbanMutations } from "@/hooks/use-kanban-mutations";
import { useProjectDisplayName } from "@/stores/session-store-hooks";
import { toErrorMessage } from "@/utils/error-messages";
import { KanbanBoard } from "./kanban-board";
import { KanbanPlanFormSheet } from "./kanban-plan-form-sheet";
import { KanbanPlanSheet } from "./kanban-plan-sheet";

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

      <KanbanBoardSectionContent
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

function KanbanBoardSectionContent({
  serverId,
  kanbanId,
  detail,
  isLoading,
  isError,
  error,
  onRetry,
}: {
  serverId: string;
  kanbanId: string;
  detail: StoredKanban | null;
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  onRetry: () => void;
}): ReactElement | null {
  const { t } = useTranslation();
  const { movePlan } = useKanbanMutations({ serverId });
  const [openPlanId, setOpenPlanId] = useState<string | null>(null);
  const [createColumnId, setCreateColumnId] = useState<string | null>(null);

  const handleMovePlan = useCallback(
    (planId: string, columnId: string, index: number) => {
      void movePlan({ kanbanId, parentPlanId: null, planId, columnId, index, movedBy: "user" });
    },
    [kanbanId, movePlan],
  );

  const handleClosePlan = useCallback(() => setOpenPlanId(null), []);
  const handleCloseCreatePlan = useCallback(() => setCreateColumnId(null), []);

  const board = useMemo(() => {
    if (!detail) {
      return null;
    }
    return { columns: detail.columns, plans: detail.plans };
  }, [detail]);

  if (isLoading && !detail) {
    return (
      <View style={styles.centered}>
        <LoadingSpinner size="small" color={styles.spinner.color} />
      </View>
    );
  }

  if (isError && !detail) {
    return (
      <View style={styles.centered}>
        <Text style={styles.errorText}>{toErrorMessage(error)}</Text>
        <Button
          variant="ghost"
          size="sm"
          onPress={onRetry}
          testID={`kanban-board-retry-${kanbanId}`}
        >
          {t("common.actions.retry")}
        </Button>
      </View>
    );
  }

  if (!detail || !board) {
    return null;
  }

  return (
    <>
      <KanbanBoard
        serverId={serverId}
        board={board}
        onOpenPlan={setOpenPlanId}
        onMovePlan={handleMovePlan}
        onCreatePlan={setCreateColumnId}
      />
      {openPlanId ? (
        <KanbanPlanSheet
          serverId={serverId}
          kanbanId={kanbanId}
          parentPlanId={null}
          planId={openPlanId}
          kanban={detail}
          visible
          onClose={handleClosePlan}
        />
      ) : null}
      {createColumnId ? (
        <KanbanPlanFormSheet
          serverId={serverId}
          kanbanId={kanbanId}
          parentPlanId={null}
          columnId={createColumnId}
          visible
          onClose={handleCloseCreatePlan}
        />
      ) : null}
    </>
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
  centered: {
    alignItems: "center",
    gap: theme.spacing[2],
    padding: theme.spacing[6],
  },
  errorText: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.sm,
  },
  spinner: {
    color: theme.colors.foregroundMuted,
  },
}));
