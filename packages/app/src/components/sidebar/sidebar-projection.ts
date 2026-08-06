import {
  splitWorkspacesByKanbanColumn,
  type KanbanColumnGroup,
  type KanbanColumnRef,
} from "@/hooks/sidebar-kanban-view-model";
import { buildStatusGroups, type StatusGroup } from "@/hooks/sidebar-status-view-model";
import {
  splitPinnedSidebarGroups,
  type PinnedSidebarGroups,
  type PinnedSidebarKeys,
} from "@/hooks/use-sidebar-pins";
import type {
  SidebarProjectEntry,
  SidebarWorkspaceEntry,
} from "@/hooks/use-sidebar-workspaces-list";
import type { SidebarGroupMode } from "@/stores/sidebar-view-store";
import {
  buildSidebarShortcutSections,
  type SidebarShortcutModel,
  type SidebarShortcutSection,
} from "@/utils/sidebar-shortcuts";

export interface SidebarProjection {
  pinnedGroups: PinnedSidebarGroups;
  statusGroups: StatusGroup[];
  kanbanColumnGroups: KanbanColumnGroup[];
  kanbanUnboundedGroups: StatusGroup[];
  shortcutModel: SidebarShortcutModel;
}

export function buildSidebarProjection(input: {
  projects: SidebarProjectEntry[];
  pinnedKeys: PinnedSidebarKeys;
  workspaceEntriesByKey: ReadonlyMap<string, SidebarWorkspaceEntry>;
  projectNamesByViewKey: Map<string, string>;
  groupMode: SidebarGroupMode;
  pinnedCollapsed: boolean;
  collapsedProjectKeys: ReadonlySet<string>;
  collapsedStatusGroupKeys: ReadonlySet<string>;
  kanbanColumnRefByWorkspaceKey?: ReadonlyMap<string, KanbanColumnRef>;
}): SidebarProjection {
  const pinnedGroups = splitPinnedSidebarGroups({
    projects: input.projects,
    keys: input.pinnedKeys,
  });
  const pinnedWorkspaceKeys = new Set(input.pinnedKeys.pinnedWorkspaceKeys);
  const unpinnedWorkspaces = Array.from(input.workspaceEntriesByKey.values()).filter(
    (workspace) => !pinnedWorkspaceKeys.has(workspace.workspaceKey),
  );
  const statusGroups =
    input.groupMode === "status"
      ? buildStatusGroups(unpinnedWorkspaces, input.projectNamesByViewKey)
      : [];

  // Kanban grouping follows the status-mode projection path (full workspace entries, not the
  // project-mode skip) because column sections and the trailing Unbounded section both need
  // per-workspace status, per docs/kanban-workflow-stacking-plan.md §8.
  let kanbanColumnGroups: KanbanColumnGroup[] = [];
  let kanbanUnboundedGroups: StatusGroup[] = [];
  if (input.groupMode === "kanban") {
    const { columnGroups, unboundedWorkspaces } = splitWorkspacesByKanbanColumn(
      unpinnedWorkspaces,
      input.kanbanColumnRefByWorkspaceKey ?? new Map(),
    );
    kanbanColumnGroups = columnGroups;
    kanbanUnboundedGroups = buildStatusGroups(unboundedWorkspaces, input.projectNamesByViewKey);
  }

  const sections: SidebarShortcutSection[] = [];
  if (!input.pinnedCollapsed) {
    sections.push({ workspaces: pinnedGroups.pinnedChats });
  }
  if (input.groupMode === "status") {
    sections.push(
      ...statusGroups.map((group) => ({
        workspaces: group.rows,
        collapsed: input.collapsedStatusGroupKeys.has(group.bucket),
      })),
    );
  } else if (input.groupMode === "kanban") {
    sections.push(
      ...kanbanColumnGroups.map((group) => ({
        workspaces: group.rows,
        collapsed: input.collapsedStatusGroupKeys.has(group.key),
      })),
      ...kanbanUnboundedGroups.map((group) => ({
        workspaces: group.rows,
        collapsed: input.collapsedStatusGroupKeys.has(`unbounded:${group.bucket}`),
      })),
    );
  } else {
    sections.push(
      ...pinnedGroups.unpinnedProjects.map((project) => ({
        workspaces: project.workspaces,
        collapsed: input.collapsedProjectKeys.has(project.viewKey),
      })),
    );
  }

  return {
    pinnedGroups,
    statusGroups,
    kanbanColumnGroups,
    kanbanUnboundedGroups,
    shortcutModel: buildSidebarShortcutSections({ sections }),
  };
}
