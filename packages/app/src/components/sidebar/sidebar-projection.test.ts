import { describe, expect, it } from "vitest";
import type { KanbanColumnRef } from "@/hooks/sidebar-kanban-view-model";
import type {
  SidebarProjectEntry,
  SidebarWorkspaceEntry,
  SidebarWorkspacePlacement,
} from "@/hooks/use-sidebar-workspaces-list";
import { buildSidebarProjection } from "./sidebar-projection";

function makeWorkspace(id: string, statusBucket: SidebarWorkspaceEntry["statusBucket"] = "done") {
  const placement: SidebarWorkspacePlacement = {
    workspaceKey: `srv:${id}`,
    serverId: "srv",
    workspaceId: id,
    projectViewKey: "project",
    projectName: "Project",
    projectKind: "git",
    workspaceKind: "worktree",
    name: id,
  };
  const entry: SidebarWorkspaceEntry = {
    ...placement,
    workspaceDirectory: "",
    workspaceDirectoryLabel: "",
    title: null,
    currentBranch: null,
    statusBucket,
    statusEnteredAt: null,
    archivingAt: null,
    diffStat: null,
    prHint: null,
    archiveHasUncommittedChanges: null,
    archiveUnpushedCommitCount: null,
    scripts: [],
    hasRunningScripts: false,
  };
  return { placement, entry };
}

function makeProject(workspaces: SidebarWorkspacePlacement[]): SidebarProjectEntry {
  return {
    viewKey: "project",
    projectName: "Project",
    projectKind: "git",
    iconWorkingDir: "/repo",
    hosts: [
      {
        serverId: "srv",
        projectId: "project",
        iconWorkingDir: "/repo",
        worktreeSupport: "supported" as const,
      },
    ],
    workspaces,
  };
}

function projectionInput(options?: {
  groupMode?: "project" | "status" | "kanban";
  pinnedCollapsed?: boolean;
  kanbanColumnRefByWorkspaceKey?: Map<string, KanbanColumnRef>;
}) {
  const pinned = makeWorkspace("pinned", "running");
  const unpinned = makeWorkspace("unpinned", "needs_input");
  return {
    projects: [makeProject([pinned.placement, unpinned.placement])],
    pinnedKeys: {
      pinnedWorkspaceKeys: [pinned.placement.workspaceKey],
      pinnedAtByKey: { [pinned.placement.workspaceKey]: "2026-07-12T12:00:00.000Z" },
    },
    workspaceEntriesByKey: new Map([
      [pinned.entry.workspaceKey, pinned.entry],
      [unpinned.entry.workspaceKey, unpinned.entry],
    ]),
    projectNamesByViewKey: new Map([["project", "Project"]]),
    groupMode: options?.groupMode ?? ("project" as const),
    pinnedCollapsed: options?.pinnedCollapsed ?? false,
    collapsedProjectKeys: new Set<string>(),
    collapsedStatusGroupKeys: new Set<string>(),
    kanbanColumnRefByWorkspaceKey: options?.kanbanColumnRefByWorkspaceKey,
  };
}

describe("buildSidebarProjection", () => {
  it("uses one pin-aware projection for project rows and shortcut order", () => {
    const projection = buildSidebarProjection(projectionInput());

    expect(projection.pinnedGroups.pinnedChats.map((entry) => entry.workspaceId)).toEqual([
      "pinned",
    ]);
    const remainingProject = projection.pinnedGroups.unpinnedProjects[0];
    expect(remainingProject?.workspaces.map((entry) => entry.workspaceId)).toEqual(["unpinned"]);
    expect(projection.shortcutModel.shortcutTargets).toEqual([
      { serverId: "srv", workspaceId: "pinned" },
      { serverId: "srv", workspaceId: "unpinned" },
    ]);
  });

  it("keeps pinned chats above status groups and removes them from those groups", () => {
    const projection = buildSidebarProjection(projectionInput({ groupMode: "status" }));

    expect(projection.statusGroups.map((group) => group.bucket)).toEqual(["needs_input"]);
    expect(projection.statusGroups[0]?.rows.map((entry) => entry.workspaceId)).toEqual([
      "unpinned",
    ]);
    expect(projection.shortcutModel.shortcutTargets).toEqual([
      { serverId: "srv", workspaceId: "pinned" },
      { serverId: "srv", workspaceId: "unpinned" },
    ]);
  });

  it("does not number pinned chats while the pinned section is collapsed", () => {
    const projection = buildSidebarProjection(
      projectionInput({ groupMode: "status", pinnedCollapsed: true }),
    );

    expect(projection.shortcutModel.shortcutTargets).toEqual([
      { serverId: "srv", workspaceId: "unpinned" },
    ]);
  });

  it("groups kanban-tracked workspaces by column and the rest into Unbounded", () => {
    const kanbanColumnRefByWorkspaceKey = new Map<string, KanbanColumnRef>([
      [
        "srv:unpinned",
        {
          serverId: "srv",
          kanbanId: "kanban-1",
          kanbanName: "Kanban",
          columnId: "backlog",
          columnName: "Backlog",
          columnOrder: 0,
          planId: "plan-1",
          planTitle: "Plan",
        },
      ],
    ]);
    const projection = buildSidebarProjection(
      projectionInput({ groupMode: "kanban", kanbanColumnRefByWorkspaceKey }),
    );

    expect(projection.kanbanColumnGroups.map((group) => group.columnName)).toEqual(["Backlog"]);
    expect(projection.kanbanColumnGroups[0]?.rows.map((entry) => entry.workspaceId)).toEqual([
      "unpinned",
    ]);
    expect(projection.kanbanUnboundedGroups).toEqual([]);
  });

  it("puts every unpinned workspace in Unbounded when the kanban index is empty", () => {
    const projection = buildSidebarProjection(projectionInput({ groupMode: "kanban" }));

    expect(projection.kanbanColumnGroups).toEqual([]);
    expect(projection.kanbanUnboundedGroups.map((group) => group.bucket)).toEqual(["needs_input"]);
  });
});
