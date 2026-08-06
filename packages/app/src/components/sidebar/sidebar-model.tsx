import React, { createContext, useContext, useMemo, type ReactNode } from "react";
import {
  useSidebarWorkspacesList,
  type SidebarWorkspaceEntry,
  type SidebarWorkspacesListResult,
} from "@/hooks/use-sidebar-workspaces-list";
import { useSidebarWorkspaceEntries } from "@/hooks/use-sidebar-workspace-entries";
import type { KanbanColumnGroup } from "@/hooks/sidebar-kanban-view-model";
import type { StatusGroup } from "@/hooks/sidebar-status-view-model";
import { usePinnedSidebarKeys, type PinnedSidebarGroups } from "@/hooks/use-sidebar-pins";
import { useSidebarKanbanIndex } from "@/hooks/use-sidebar-kanban-index";
import { useSidebarCollapsedSectionsStore } from "@/stores/sidebar-collapsed-sections-store";
import { useSidebarViewStore, type SidebarGroupMode } from "@/stores/sidebar-view-store";
import type { SidebarShortcutModel } from "@/utils/sidebar-shortcuts";
import { buildSidebarProjection } from "./sidebar-projection";

interface SidebarModel extends SidebarWorkspacesListResult {
  workspaceEntriesByKey: ReadonlyMap<string, SidebarWorkspaceEntry>;
  groupMode: SidebarGroupMode;
  statusGroups: StatusGroup[];
  kanbanColumnGroups: KanbanColumnGroup[];
  kanbanUnboundedGroups: StatusGroup[];
  pinnedGroups: PinnedSidebarGroups;
  collapsedProjectKeys: ReadonlySet<string>;
  toggleProjectCollapsed: (projectViewKey: string) => void;
  shortcutModel: SidebarShortcutModel;
}

const SidebarModelContext = createContext<SidebarModel | null>(null);
const EMPTY_WORKSPACE_ENTRIES = new Map<string, SidebarWorkspaceEntry>();

export function SidebarModelProvider({
  active,
  children,
}: {
  active?: boolean;
  children: ReactNode;
}) {
  const list = useSidebarWorkspacesList();
  const groupMode = useSidebarViewStore((state) => state.groupMode);
  const collapsedProjectKeys = useSidebarCollapsedSectionsStore(
    (state) => state.collapsedProjectKeys,
  );
  const collapsedStatusGroupKeys = useSidebarCollapsedSectionsStore(
    (state) => state.collapsedStatusGroupKeys,
  );
  const pinnedCollapsed = useSidebarCollapsedSectionsStore((state) => state.collapsedPinned);
  const toggleProjectCollapsed = useSidebarCollapsedSectionsStore(
    (state) => state.toggleProjectCollapsed,
  );
  const isStatusMode = groupMode === "status";
  const isKanbanMode = groupMode === "kanban";
  const workspaceEntriesByKey = useSidebarWorkspaceEntries(
    list.workspacePlacements,
    active !== false || isStatusMode || isKanbanMode,
  );
  const projectionWorkspaceEntriesByKey =
    isStatusMode || isKanbanMode ? workspaceEntriesByKey : EMPTY_WORKSPACE_ENTRIES;
  const pinnedKeys = usePinnedSidebarKeys(list.projects);
  const { columnRefByWorkspaceKey } = useSidebarKanbanIndex({ enabled: isKanbanMode });
  const projection = useMemo(
    () =>
      buildSidebarProjection({
        projects: list.projects,
        pinnedKeys,
        workspaceEntriesByKey: projectionWorkspaceEntriesByKey,
        projectNamesByViewKey: list.projectNamesByViewKey,
        groupMode,
        pinnedCollapsed,
        collapsedProjectKeys,
        collapsedStatusGroupKeys,
        kanbanColumnRefByWorkspaceKey: columnRefByWorkspaceKey,
      }),
    [
      collapsedProjectKeys,
      collapsedStatusGroupKeys,
      columnRefByWorkspaceKey,
      groupMode,
      list.projectNamesByViewKey,
      list.projects,
      pinnedCollapsed,
      pinnedKeys,
      projectionWorkspaceEntriesByKey,
    ],
  );
  const value = useMemo(
    () => ({
      ...list,
      workspaceEntriesByKey,
      groupMode,
      statusGroups: projection.statusGroups,
      kanbanColumnGroups: projection.kanbanColumnGroups,
      kanbanUnboundedGroups: projection.kanbanUnboundedGroups,
      pinnedGroups: projection.pinnedGroups,
      collapsedProjectKeys,
      toggleProjectCollapsed,
      shortcutModel: projection.shortcutModel,
    }),
    [
      collapsedProjectKeys,
      groupMode,
      list,
      projection,
      toggleProjectCollapsed,
      workspaceEntriesByKey,
    ],
  );

  return <SidebarModelContext.Provider value={value}>{children}</SidebarModelContext.Provider>;
}

export function useSidebarModel(): SidebarModel {
  const model = useContext(SidebarModelContext);
  if (!model) throw new Error("SidebarModelProvider is required");
  return model;
}
