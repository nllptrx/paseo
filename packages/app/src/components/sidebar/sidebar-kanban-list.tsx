import { useCallback, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { View, Text, Pressable, ScrollView, type PressableStateCallbackType } from "react-native";
import { NestableScrollContainer } from "react-native-draggable-flatlist";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ChevronDown, ChevronRight, Columns3 } from "lucide-react-native";
import type { KanbanColumnGroup } from "@/hooks/sidebar-kanban-view-model";
import type { StatusGroup } from "@/hooks/sidebar-status-view-model";
import { type SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import type { HostBadgeModel } from "@/hosts/appearance";
import { isWeb as platformIsWeb, isNative as platformIsNative } from "@/constants/platform";
import type { Theme } from "@/styles/theme";
import { useSidebarCollapsedSectionsStore } from "@/stores/sidebar-collapsed-sections-store";
import { PinnedSectionHeader } from "@/components/sidebar/pinned-section-header";
import { SidebarGroupToggleRow } from "@/components/sidebar/sidebar-group-toggle-row";
import { useLimitedSidebarGroup } from "@/components/sidebar/use-limited-sidebar-group";
import {
  SidebarStatusWorkspaceList,
  StatusWorkspaceRow,
} from "@/components/sidebar/sidebar-status-list";
import type { ToggleSidebarWorkspacePin } from "@/hooks/use-sidebar-workspace-pin";

const UNBOUNDED_GROUP_KEY = "unbounded";

const foregroundMutedColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});

const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronRight = withUnistyles(ChevronRight);
const ThemedColumns3 = withUnistyles(Columns3);

interface KanbanWorkspaceListProps {
  columnGroups: KanbanColumnGroup[];
  unboundedGroups: StatusGroup[];
  pinnedWorkspaces: SidebarWorkspaceEntry[];
  projectIconByProjectViewKey: ReadonlyMap<string, string | null>;
  shortcutIndexByWorkspaceKey: Map<string, number>;
  showShortcutBadges: boolean;
  onWorkspacePress?: () => void;
  hostBadgeByServerId: ReadonlyMap<string, HostBadgeModel>;
  supportsPinningByServerId: ReadonlyMap<string, boolean>;
  onToggleWorkspacePin: ToggleSidebarWorkspacePin;
  listHeaderComponent?: ReactNode;
}

/**
 * Kanban grouping mode: rows stay workspaces, sectioned by the column of the Plan that
 * references them (board order), with a trailing Unbounded section for everything not on a
 * kanban — the sidebar's default experience, unchanged, per
 * `docs/kanban-workflow-stacking-plan.md` §4.
 */
export function SidebarKanbanWorkspaceList({
  columnGroups,
  unboundedGroups,
  pinnedWorkspaces,
  projectIconByProjectViewKey,
  shortcutIndexByWorkspaceKey,
  showShortcutBadges,
  onWorkspacePress,
  hostBadgeByServerId,
  supportsPinningByServerId,
  onToggleWorkspacePin,
  listHeaderComponent,
}: KanbanWorkspaceListProps) {
  const { t } = useTranslation();
  const collapsedGroupKeys = useSidebarCollapsedSectionsStore(
    (state) => state.collapsedStatusGroupKeys,
  );
  const pinnedCollapsed = useSidebarCollapsedSectionsStore((state) => state.collapsedPinned);
  const togglePinnedCollapsed = useSidebarCollapsedSectionsStore(
    (state) => state.togglePinnedCollapsed,
  );
  const {
    visibleItems: visiblePinnedWorkspaces,
    expanded: pinnedWorkspacesExpanded,
    canToggle: canTogglePinnedWorkspaces,
    toggleExpanded: togglePinnedWorkspacesExpanded,
  } = useLimitedSidebarGroup(pinnedWorkspaces);

  const shortcutIndex = showShortcutBadges ? shortcutIndexByWorkspaceKey : new Map();

  const content = (
    <>
      {pinnedWorkspaces.length > 0 ? (
        <View style={styles.pinnedSection} testID="sidebar-pinned-section">
          <PinnedSectionHeader collapsed={pinnedCollapsed} onToggle={togglePinnedCollapsed} />
          {pinnedCollapsed ? null : (
            <>
              {visiblePinnedWorkspaces.map((workspace) => (
                <StatusWorkspaceRow
                  key={workspace.workspaceKey}
                  workspace={workspace}
                  hostBadge={hostBadgeByServerId.get(workspace.serverId) ?? null}
                  projectName={workspace.projectName}
                  projectIconDataUri={
                    projectIconByProjectViewKey.get(workspace.projectViewKey) ?? null
                  }
                  inStatusGroup={false}
                  shortcutNumber={shortcutIndex.get(workspace.workspaceKey) ?? null}
                  showShortcutBadge={showShortcutBadges}
                  canPin={supportsPinningByServerId.get(workspace.serverId) === true}
                  onToggleWorkspacePin={onToggleWorkspacePin}
                  onWorkspacePress={onWorkspacePress}
                />
              ))}
              {canTogglePinnedWorkspaces ? (
                <SidebarGroupToggleRow
                  expanded={pinnedWorkspacesExpanded}
                  onPress={togglePinnedWorkspacesExpanded}
                  testID="sidebar-pinned-show-more"
                />
              ) : null}
            </>
          )}
        </View>
      ) : null}
      {listHeaderComponent}
      {columnGroups.map((group) => (
        <KanbanColumnSection
          key={group.key}
          group={group}
          collapsed={collapsedGroupKeys.has(group.key)}
          projectIconByProjectViewKey={projectIconByProjectViewKey}
          shortcutIndex={shortcutIndex}
          showShortcutBadges={showShortcutBadges}
          onWorkspacePress={onWorkspacePress}
          hostBadgeByServerId={hostBadgeByServerId}
          supportsPinningByServerId={supportsPinningByServerId}
          onToggleWorkspacePin={onToggleWorkspacePin}
        />
      ))}
      <UnboundedSection
        unboundedGroups={unboundedGroups}
        collapsed={collapsedGroupKeys.has(UNBOUNDED_GROUP_KEY)}
        label={t("sidebar.kanban.unbounded")}
        projectIconByProjectViewKey={projectIconByProjectViewKey}
        shortcutIndexByWorkspaceKey={shortcutIndex}
        showShortcutBadges={showShortcutBadges}
        onWorkspacePress={onWorkspacePress}
        hostBadgeByServerId={hostBadgeByServerId}
        supportsPinningByServerId={supportsPinningByServerId}
        onToggleWorkspacePin={onToggleWorkspacePin}
      />
    </>
  );

  return (
    <View style={styles.container}>
      {platformIsNative ? (
        <NestableScrollContainer
          style={styles.list}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
          testID="sidebar-kanban-list-scroll"
        >
          {content}
        </NestableScrollContainer>
      ) : (
        <ScrollView
          style={styles.list}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
          testID="sidebar-kanban-list-scroll"
        >
          {content}
        </ScrollView>
      )}
    </View>
  );
}

const columnLeadingIcon = <ThemedColumns3 size={14} uniProps={foregroundMutedColorMapping} />;

function KanbanColumnSection({
  group,
  collapsed,
  projectIconByProjectViewKey,
  shortcutIndex,
  showShortcutBadges,
  onWorkspacePress,
  hostBadgeByServerId,
  supportsPinningByServerId,
  onToggleWorkspacePin,
}: {
  group: KanbanColumnGroup;
  collapsed: boolean;
  projectIconByProjectViewKey: ReadonlyMap<string, string | null>;
  shortcutIndex: Map<string, number>;
  showShortcutBadges: boolean;
  onWorkspacePress?: () => void;
  hostBadgeByServerId: ReadonlyMap<string, HostBadgeModel>;
  supportsPinningByServerId: ReadonlyMap<string, boolean>;
  onToggleWorkspacePin: ToggleSidebarWorkspacePin;
}) {
  const {
    visibleItems: visibleWorkspaces,
    expanded: workspacesExpanded,
    canToggle: canToggleWorkspaces,
    toggleExpanded: toggleWorkspacesExpanded,
  } = useLimitedSidebarGroup(group.rows);

  return (
    <View style={collapsed ? undefined : styles.groupBlockExpanded}>
      <KanbanGroupHeader
        groupKey={group.key}
        label={group.columnName}
        collapsed={collapsed}
        icon={columnLeadingIcon}
      />
      {!collapsed ? (
        <View testID={`sidebar-kanban-column-rows-${group.columnId}`}>
          {visibleWorkspaces.map((workspace) => (
            <StatusWorkspaceRow
              key={workspace.workspaceKey}
              workspace={workspace}
              hostBadge={hostBadgeByServerId.get(workspace.serverId) ?? null}
              projectName={workspace.projectName}
              projectIconDataUri={projectIconByProjectViewKey.get(workspace.projectViewKey) ?? null}
              shortcutNumber={shortcutIndex.get(workspace.workspaceKey) ?? null}
              showShortcutBadge={showShortcutBadges}
              canPin={supportsPinningByServerId.get(workspace.serverId) === true}
              onToggleWorkspacePin={onToggleWorkspacePin}
              onWorkspacePress={onWorkspacePress}
            />
          ))}
          {canToggleWorkspaces ? (
            <SidebarGroupToggleRow
              expanded={workspacesExpanded}
              onPress={toggleWorkspacesExpanded}
              indented
              testID={`sidebar-kanban-show-more-${group.columnId}`}
            />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function UnboundedSection({
  unboundedGroups,
  collapsed,
  label,
  projectIconByProjectViewKey,
  shortcutIndexByWorkspaceKey,
  showShortcutBadges,
  onWorkspacePress,
  hostBadgeByServerId,
  supportsPinningByServerId,
  onToggleWorkspacePin,
}: {
  unboundedGroups: StatusGroup[];
  collapsed: boolean;
  label: string;
  projectIconByProjectViewKey: ReadonlyMap<string, string | null>;
  shortcutIndexByWorkspaceKey: Map<string, number>;
  showShortcutBadges: boolean;
  onWorkspacePress?: () => void;
  hostBadgeByServerId: ReadonlyMap<string, HostBadgeModel>;
  supportsPinningByServerId: ReadonlyMap<string, boolean>;
  onToggleWorkspacePin: ToggleSidebarWorkspacePin;
}) {
  if (unboundedGroups.length === 0) return null;

  return (
    <View style={styles.groupBlockExpanded}>
      <KanbanGroupHeader groupKey={UNBOUNDED_GROUP_KEY} label={label} collapsed={collapsed} />
      {!collapsed ? (
        <SidebarStatusWorkspaceList
          groups={unboundedGroups}
          pinnedWorkspaces={[]}
          projectIconByProjectViewKey={projectIconByProjectViewKey}
          shortcutIndexByWorkspaceKey={shortcutIndexByWorkspaceKey}
          showShortcutBadges={showShortcutBadges}
          onWorkspacePress={onWorkspacePress}
          hostBadgeByServerId={hostBadgeByServerId}
          supportsPinningByServerId={supportsPinningByServerId}
          onToggleWorkspacePin={onToggleWorkspacePin}
          disableOwnScroll
        />
      ) : null}
    </View>
  );
}

function KanbanGroupHeader({
  groupKey,
  label,
  collapsed,
  icon,
}: {
  groupKey: string;
  label: string;
  collapsed: boolean;
  icon?: ReactNode;
}) {
  const [isHovered, setIsHovered] = useState(false);
  const toggleCollapsed = useSidebarCollapsedSectionsStore(
    (state) => state.toggleStatusGroupCollapsed,
  );
  const handlePress = useCallback(() => {
    toggleCollapsed(groupKey);
  }, [groupKey, toggleCollapsed]);
  const handleHoverIn = useCallback(() => setIsHovered(true), []);
  const handleHoverOut = useCallback(() => setIsHovered(false), []);
  const rowStyle = useCallback(
    ({ pressed }: PressableStateCallbackType) => [
      styles.groupRow,
      isHovered && styles.groupRowHovered,
      pressed && styles.groupRowPressed,
    ],
    [isHovered],
  );
  const accessibilityState = useMemo(() => ({ expanded: !collapsed }), [collapsed]);

  let leadingVisual: ReactNode;
  if (!isHovered) {
    leadingVisual = icon ?? null;
  } else if (collapsed) {
    leadingVisual = <ThemedChevronRight size={14} uniProps={foregroundMutedColorMapping} />;
  } else {
    leadingVisual = <ThemedChevronDown size={14} uniProps={foregroundMutedColorMapping} />;
  }

  return (
    <View onPointerEnter={handleHoverIn} onPointerLeave={handleHoverOut}>
      <Pressable
        accessibilityRole={platformIsWeb ? undefined : "button"}
        accessibilityLabel={`${label} kanban group`}
        accessibilityState={accessibilityState}
        style={rowStyle}
        onPress={handlePress}
        testID={`sidebar-kanban-group-${groupKey}`}
      >
        <View style={styles.groupRowLeft}>
          <View style={styles.groupLeadingVisualSlot}>{leadingVisual}</View>
          <Text style={styles.groupTitle} numberOfLines={1}>
            {label}
          </Text>
        </View>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
  },
  list: {
    flex: 1,
  },
  listContent: {
    paddingHorizontal: theme.spacing[2],
    paddingTop: 2,
    paddingBottom: theme.spacing[4],
  },
  pinnedSection: {
    marginBottom: theme.spacing[1],
  },
  groupBlockExpanded: {
    paddingBottom: theme.spacing[3],
  },
  groupRow: {
    minHeight: 36,
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
    marginBottom: theme.spacing[2],
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    userSelect: "none",
  },
  groupRowHovered: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  groupRowPressed: {
    backgroundColor: theme.colors.surface2,
  },
  groupRowLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flex: 1,
    minWidth: 0,
  },
  groupLeadingVisualSlot: {
    position: "relative",
    width: theme.iconSize.md,
    height: theme.iconSize.md,
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  groupTitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: "400",
    minWidth: 0,
    flexShrink: 1,
  },
}));
