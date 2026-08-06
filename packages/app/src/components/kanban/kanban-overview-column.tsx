import { useCallback, useMemo, type ReactElement } from "react";
import { Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { ChevronRight } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { HostStatusDot } from "@/components/host-status-dot";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import type { AggregatedKanban } from "@/kanban/aggregated-kanbans";
import { deriveBoard, flattenBoardForOverview } from "@/kanban/derive-board";
import { useKanban } from "@/hooks/use-kanbans";
import { useKanbanDraftOrder } from "@/stores/kanban-draft-order-store";
import { useProjectDisplayName } from "@/stores/session-store-hooks";
import { KanbanCard } from "./kanban-card";

/** The overview is a way in, not the board. Past this many cards the answer is
 * to open the board, which is one press away. */
const OVERVIEW_RENDER_CAP = 20;

const ThemedChevronRight = withUnistyles(ChevronRight);
const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

const NO_ACTIONS = () => [];

export interface KanbanOverviewColumnProps {
  kanban: AggregatedKanban;
  showHostBadge: boolean;
  onOpenBoard: (kanban: AggregatedKanban) => void;
  onOpenPlan: (kanban: AggregatedKanban, planId: string) => void;
}

/**
 * One project's work as a single column: running first, then drafts, then what
 * finished. Read-only — dragging belongs to the board, where the columns say
 * what a drop would mean.
 */
export function KanbanOverviewColumn({
  kanban,
  showHostBadge,
  onOpenBoard,
  onOpenPlan,
}: KanbanOverviewColumnProps): ReactElement {
  const { t } = useTranslation();
  const { serverId } = kanban;
  const { kanban: detail, isLoading } = useKanban({ serverId, kanbanId: kanban.id });
  const draftOrder = useKanbanDraftOrder(kanban.id);
  const projectName = useProjectDisplayName(serverId, kanban.projectId);

  const board = useMemo(
    () => (detail ? deriveBoard(detail, draftOrder) : null),
    [detail, draftOrder],
  );
  const plans = useMemo(
    () => (board ? flattenBoardForOverview(board, OVERVIEW_RENDER_CAP) : []),
    [board],
  );
  const hiddenCount = (board?.totalCount ?? 0) - plans.length;

  const handleOpenBoard = useCallback(() => onOpenBoard(kanban), [kanban, onOpenBoard]);
  const handleOpenPlan = useCallback(
    (planId: string) => () => onOpenPlan(kanban, planId),
    [kanban, onOpenPlan],
  );

  return (
    <View style={styles.column} testID={`kanban-overview-${kanban.id}`}>
      <Pressable
        onPress={handleOpenBoard}
        style={styles.header}
        accessibilityRole="button"
        testID={`kanban-overview-open-${kanban.id}`}
      >
        {showHostBadge ? <HostStatusDot serverId={serverId} /> : null}
        <Text style={styles.title} numberOfLines={1}>
          {projectName ?? kanban.name}
        </Text>
        <Text style={styles.count}>{board?.totalCount ?? 0}</Text>
        <ThemedChevronRight size={ICON_SIZE.sm} uniProps={mutedIconMapping} />
      </Pressable>

      <View style={styles.body}>
        {isLoading && !detail ? <LoadingSpinner size="small" color={styles.spinner.color} /> : null}
        {plans.map((plan) => (
          <KanbanCard
            key={plan.id}
            serverId={serverId}
            plan={plan}
            onPress={handleOpenPlan(plan.id)}
            actions={NO_ACTIONS()}
          />
        ))}
        {hiddenCount > 0 ? (
          <Pressable onPress={handleOpenBoard} style={styles.more} accessibilityRole="button">
            <Text style={styles.moreText}>
              {t("kanban.column.showMore", { count: hiddenCount })}
            </Text>
          </Pressable>
        ) : null}
        {!isLoading && plans.length === 0 ? (
          <View style={styles.empty}>
            <Text style={styles.emptyText}>{t("kanban.column.empty")}</Text>
          </View>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  column: {
    width: 296,
    flexShrink: 0,
    gap: theme.spacing[1],
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1.5],
    borderRadius: theme.borderRadius.md,
  },
  title: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
  },
  count: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  body: {
    gap: theme.spacing[2],
    padding: theme.spacing[1],
  },
  more: {
    paddingVertical: theme.spacing[1.5],
    alignItems: "center",
  },
  moreText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  empty: {
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    paddingVertical: theme.spacing[4],
    alignItems: "center",
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  spinner: {
    color: theme.colors.foregroundMuted,
  },
}));
