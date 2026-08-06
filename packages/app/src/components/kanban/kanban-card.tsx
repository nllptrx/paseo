import { useCallback, useMemo, useState, type ReactElement } from "react";
import { Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { FolderKanban, MoreVertical, Workflow } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { Column, KanbanPlan, NestedPlan } from "@getpaseo/protocol/kanban/types";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { StatusBucketDot } from "@/components/status-bucket-dot";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { deriveKanbanPlanWorkspaceIds, deriveWorkflowStepProgress } from "@/kanban/plan-status";
import { useWorkspaceStatusesByIds } from "@/stores/session-store-hooks";
import { aggregateSidebarStateBuckets, type SidebarStateBucket } from "@/utils/sidebar-agent-state";

const ThemedFolderKanban = withUnistyles(FolderKanban);
const ThemedWorkflow = withUnistyles(Workflow);
const ThemedMoreVertical = withUnistyles(MoreVertical);
const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const foregroundIconMapping = (theme: Theme) => ({ color: theme.colors.foreground });

export interface KanbanCardProps {
  serverId: string;
  plan: KanbanPlan | NestedPlan;
  columns: Column[];
  currentColumnId: string;
  onPress: () => void;
  onMoveToColumn: (columnId: string) => void;
}

export function KanbanCard({
  serverId,
  plan,
  columns,
  currentColumnId,
  onPress,
  onMoveToColumn,
}: KanbanCardProps): ReactElement {
  const { t } = useTranslation();
  const [menuOpen, setMenuOpen] = useState(false);

  const workspaceIds = useMemo(() => deriveKanbanPlanWorkspaceIds(plan), [plan]);
  const statusByWorkspaceId = useWorkspaceStatusesByIds(serverId, workspaceIds);
  const bucket = useMemo<SidebarStateBucket | null>(() => {
    if (statusByWorkspaceId.size === 0) {
      return null;
    }
    return aggregateSidebarStateBuckets(statusByWorkspaceId.values());
  }, [statusByWorkspaceId]);

  const progressLabel = useMemo(() => {
    if (plan.body.type === "workflow") {
      const progress = deriveWorkflowStepProgress(plan.body.steps);
      return `${progress.done}/${progress.total}`;
    }
    return t("kanban.card.nestedPlanCount", { count: Object.keys(plan.body.plans).length });
  }, [plan, t]);

  const otherColumns = useMemo(
    () => columns.filter((column) => column.id !== currentColumnId),
    [columns, currentColumnId],
  );

  const handleMoveTo = useCallback(
    (columnId: string) => () => onMoveToColumn(columnId),
    [onMoveToColumn],
  );

  return (
    <Pressable
      onPress={onPress}
      style={styles.card}
      testID={`kanban-card-${plan.id}`}
      accessibilityRole="button"
    >
      <View style={styles.header}>
        {plan.body.type === "nested_kanban" ? (
          <ThemedFolderKanban size={ICON_SIZE.sm} uniProps={mutedIconMapping} />
        ) : (
          <ThemedWorkflow size={ICON_SIZE.sm} uniProps={mutedIconMapping} />
        )}
        <Text style={styles.title} numberOfLines={2}>
          {plan.title}
        </Text>
        <View style={styles.dotSlot}>
          <StatusBucketDot bucket={bucket} />
        </View>
      </View>
      <View style={styles.footer}>
        <Text style={styles.progress}>{progressLabel}</Text>
        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger
            style={styles.menuTrigger}
            testID={`kanban-card-menu-${plan.id}`}
            accessibilityRole="button"
            accessibilityLabel={t("kanban.card.moveMenu")}
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
            testID={`kanban-card-menu-content-${plan.id}`}
          >
            <DropdownMenuLabel>{t("kanban.card.moveToColumn")}</DropdownMenuLabel>
            {otherColumns.map((column) => (
              <DropdownMenuItem
                key={column.id}
                testID={`kanban-card-move-${plan.id}-${column.id}`}
                onSelect={handleMoveTo(column.id)}
              >
                {column.name}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  card: {
    backgroundColor: theme.colors.surface1,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    padding: theme.spacing[3],
    gap: theme.spacing[2],
  },
  header: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[2],
  },
  title: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  // Keeps the dot on the first line of a title that may wrap to two.
  dotSlot: {
    marginTop: 4,
  },
  footer: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  progress: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  menuTrigger: {
    width: 24,
    height: 24,
    alignItems: "center",
    justifyContent: "center",
  },
}));
