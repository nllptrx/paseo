import { useMemo, useState, type ReactElement } from "react";
import { Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { FolderKanban, GitBranch, MoreVertical, Workflow } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { KanbanPlan, NestedPlan } from "@getpaseo/protocol/kanban/types";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { StatusBucketDot } from "@/components/status-bucket-dot";
import { getProviderIcon } from "@/components/provider-icons";
import { useCompactTimeAgo } from "@/hooks/use-compact-time-ago";
import { useElapsedLabel } from "@/hooks/use-elapsed-label";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { derivePlanActiveSince, derivePlanProviders } from "@/kanban/card-model";
import { deriveKanbanPlanWorkspaceIds, deriveWorkflowStepProgress } from "@/kanban/plan-status";
import { useKanbanPlanWorkspaceSignals } from "@/hooks/use-kanban-plan-workspace-signals";
import { aggregateSidebarStateBuckets, type SidebarStateBucket } from "@/utils/sidebar-agent-state";

const ThemedFolderKanban = withUnistyles(FolderKanban);
const ThemedWorkflow = withUnistyles(Workflow);
const ThemedMoreVertical = withUnistyles(MoreVertical);
const ThemedGitBranch = withUnistyles(GitBranch);
const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const foregroundIconMapping = (theme: Theme) => ({ color: theme.colors.foreground });

const PROVIDER_ICON_LIMIT = 3;

export interface KanbanCardAction {
  key: string;
  label: string;
  onSelect: () => void;
}

export interface KanbanCardProps {
  serverId: string;
  plan: KanbanPlan | NestedPlan;
  onPress: () => void;
  actions: KanbanCardAction[];
  /** Rendered inside the drag overlay: lifted, non-interactive. */
  isOverlay?: boolean;
  /** The in-column original while its overlay clone is being dragged. */
  isDragSource?: boolean;
}

export function KanbanCard({
  serverId,
  plan,
  onPress,
  actions,
  isOverlay = false,
  isDragSource = false,
}: KanbanCardProps): ReactElement {
  const { t } = useTranslation();
  const [menuOpen, setMenuOpen] = useState(false);

  const workspaceIds = useMemo(() => deriveKanbanPlanWorkspaceIds(plan), [plan]);
  const { statusByWorkspaceId, branch } = useKanbanPlanWorkspaceSignals(serverId, workspaceIds);
  const bucket = useMemo<SidebarStateBucket | null>(() => {
    if (statusByWorkspaceId.size === 0) {
      return null;
    }
    return aggregateSidebarStateBuckets(statusByWorkspaceId.values());
  }, [statusByWorkspaceId]);

  const providers = useMemo(() => derivePlanProviders(plan), [plan]);
  const activeSince = useMemo(() => derivePlanActiveSince(plan), [plan]);
  const elapsed = useElapsedLabel(activeSince);
  const updatedAt = useMemo(() => new Date(plan.updatedAt), [plan.updatedAt]);
  const timeAgo = useCompactTimeAgo(activeSince === null ? updatedAt : null);

  // Running work reports how long it has been at it; settled work reports when it
  // last changed. Only one of the two is ever meaningful.
  const timingLabel = elapsed ? t("kanban.card.workedFor", { duration: elapsed }) : timeAgo || null;

  const progressLabel = useMemo(() => {
    if (plan.body.type === "workflow") {
      const progress = deriveWorkflowStepProgress(plan.body.steps);
      return t("kanban.card.stepProgress", { done: progress.done, total: progress.total });
    }
    return t("kanban.card.nestedPlanCount", { count: Object.keys(plan.body.plans).length });
  }, [plan, t]);

  return (
    <Pressable
      onPress={isOverlay ? undefined : onPress}
      style={[styles.card, isOverlay && styles.cardOverlay, isDragSource && styles.cardDragSource]}
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

      <View style={styles.meta}>
        <View style={styles.providers}>
          {providers.slice(0, PROVIDER_ICON_LIMIT).map((provider) => (
            <ProviderGlyph key={provider} provider={provider} />
          ))}
        </View>
        <Text style={styles.metaText}>{progressLabel}</Text>
        {branch ? (
          <View style={styles.branch}>
            <ThemedGitBranch size={ICON_SIZE.xs} uniProps={mutedIconMapping} />
            <Text style={styles.branchText} numberOfLines={1}>
              {branch}
            </Text>
          </View>
        ) : null}

        <View style={styles.metaTrailing}>
          {timingLabel ? <Text style={styles.metaText}>{timingLabel}</Text> : null}
          {isOverlay || actions.length === 0 ? null : (
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
                {actions.map((action) => (
                  <DropdownMenuItem
                    key={action.key}
                    testID={`kanban-card-action-${plan.id}-${action.key}`}
                    onSelect={action.onSelect}
                  >
                    {action.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </View>
      </View>
    </Pressable>
  );
}

function ProviderGlyph({ provider }: { provider: string }): ReactElement {
  const Icon = getProviderIcon(provider);
  const ThemedIcon = useMemo(() => withUnistyles(Icon), [Icon]);
  return <ThemedIcon size={ICON_SIZE.xs} uniProps={mutedIconMapping} />;
}

const styles = StyleSheet.create((theme) => ({
  card: {
    width: "100%",
    backgroundColor: theme.colors.surface1,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    gap: theme.spacing[1.5],
  },
  cardOverlay: {
    backgroundColor: theme.colors.surface2,
    borderColor: theme.colors.borderAccent,
  },
  cardDragSource: {
    opacity: 0.4,
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
  // One line of peers separated by spacing, matching the workspace row's meta line.
  meta: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minWidth: 0,
  },
  providers: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    flexShrink: 0,
  },
  metaText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    flexShrink: 0,
  },
  // The only item allowed to give way when the line runs out of room.
  branch: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    minWidth: 0,
    flexShrink: 1,
  },
  branchText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    flexShrink: 1,
  },
  metaTrailing: {
    marginLeft: "auto",
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    flexShrink: 0,
  },
  menuTrigger: {
    width: 24,
    height: 24,
    alignItems: "center",
    justifyContent: "center",
  },
}));
