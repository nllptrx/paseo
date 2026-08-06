import type { KanbanPlan, StoredKanban } from "@getpaseo/protocol/kanban/types";
import { describe, expect, it } from "vitest";
import type { SidebarWorkspaceEntry } from "@/hooks/sidebar-workspaces-view-model";
import {
  resolveKanbanWorkspaceColumns,
  splitWorkspacesByKanbanColumn,
} from "./sidebar-kanban-view-model";

function workflowPlan(overrides: Partial<KanbanPlan> & { id: string }): KanbanPlan {
  return {
    title: "Untitled",
    description: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    archivedAt: null,
    body: { type: "workflow", steps: [] },
    ...overrides,
  };
}

function existingStep(workspaceId: string) {
  return {
    id: "step-1",
    name: "Work",
    prompt: "do the work",
    agents: [{ provider: "claude" }],
    completion: "all" as const,
    workspace: { mode: "existing" as const, workspaceId },
    trigger: { type: "manual" as const },
    runs: [],
  };
}

function kanban(overrides: Partial<StoredKanban> & { id: string }): StoredKanban {
  return {
    projectId: "project-1",
    name: "Kanban",
    archiveWorkspacesOnDone: false,
    orchestrator: null,
    plans: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    archivedAt: null,
    ...overrides,
  };
}

function workspaceEntry(overrides: Partial<SidebarWorkspaceEntry> & { workspaceKey: string }) {
  return {
    serverId: "server-1",
    workspaceId: overrides.workspaceKey.split(":")[1] ?? "",
    projectViewKey: "project-view-1",
    projectName: "Project",
    projectKind: "git",
    workspaceKind: "worktree",
    name: "workspace",
    statusBucket: "running",
    statusEnteredAt: null,
    workspaceDirectory: "/tmp/workspace",
    workspaceDirectoryLabel: "~/workspace",
    title: null,
    currentBranch: null,
    archivingAt: null,
    diffStat: null,
    prHint: null,
    archiveHasUncommittedChanges: null,
    archiveUnpushedCommitCount: null,
    scripts: [],
    hasRunningScripts: false,
    ...overrides,
  } as SidebarWorkspaceEntry;
}

describe("resolveKanbanWorkspaceColumns", () => {
  it("maps a workspace declared via the existing strategy to its plan's derived column", () => {
    const board = kanban({
      id: "kanban-1",
      plans: {
        "plan-1": workflowPlan({
          id: "plan-1",
          title: "Ship the thing",
          body: { type: "workflow", steps: [existingStep("workspace-1")] },
        }),
      },
    });

    const index = resolveKanbanWorkspaceColumns("server-1", board);

    expect(index.get("workspace-1")).toEqual({
      serverId: "server-1",
      kanbanId: "kanban-1",
      kanbanName: "Kanban",
      columnId: "draft",
      columnName: "draft",
      columnOrder: 0,
      planId: "plan-1",
      planTitle: "Ship the thing",
    });
  });

  it("maps a workspace only referenced through a step run, which is also what puts it in progress", () => {
    const board = kanban({
      id: "kanban-1",
      plans: {
        "plan-1": workflowPlan({
          id: "plan-1",
          body: {
            type: "workflow",
            steps: [
              {
                id: "step-1",
                name: "Work",
                prompt: "do it",
                agents: [{ provider: "claude" }],
                completion: "all",
                workspace: { mode: "worktree" },
                trigger: { type: "immediate" },
                runs: [
                  {
                    id: "run-1",
                    startedAt: "2026-01-01T00:00:00.000Z",
                    endedAt: null,
                    status: "running",
                    agentIds: ["agent-1"],
                    workspaceIds: ["workspace-2"],
                    scheduleId: null,
                    error: null,
                  },
                ],
              },
            ],
          },
        }),
      },
    });

    const index = resolveKanbanWorkspaceColumns("server-1", board);

    expect(index.get("workspace-2")?.columnId).toBe("inProgress");
  });

  it("ignores archived plans", () => {
    const board = kanban({
      id: "kanban-1",
      plans: {
        "plan-1": workflowPlan({
          id: "plan-1",
          archivedAt: "2026-01-02T00:00:00.000Z",
          body: { type: "workflow", steps: [existingStep("workspace-1")] },
        }),
        "plan-2": workflowPlan({
          id: "plan-2",
          body: { type: "workflow", steps: [existingStep("workspace-3")] },
        }),
      },
    });

    const index = resolveKanbanWorkspaceColumns("server-1", board);

    // plan-2 is not archived, so its workspace is still tracked; plan-1's is not.
    expect(index.has("workspace-1")).toBe(false);
    expect(index.get("workspace-3")?.planId).toBe("plan-2");
  });

  it("resolves a nested-kanban child workspace to the outer card's column", () => {
    const board = kanban({
      id: "kanban-1",
      plans: {
        "plan-1": {
          id: "plan-1",
          title: "Sub-board",
          description: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          archivedAt: null,
          body: {
            type: "nested_kanban",
            plans: {
              "nested-1": {
                id: "nested-1",
                title: "Nested step",
                description: null,
                createdAt: "2026-01-01T00:00:00.000Z",
                updatedAt: "2026-01-01T00:00:00.000Z",
                archivedAt: null,
                body: { type: "workflow", steps: [existingStep("workspace-4")] },
              },
            },
          },
        },
      },
    });

    const index = resolveKanbanWorkspaceColumns("server-1", board);

    expect(index.get("workspace-4")?.columnId).toBe("draft");
    expect(index.get("workspace-4")?.planId).toBe("plan-1");
  });

  it("is the dedup check the Add to Kanban action reuses: undefined for a workspace no plan tracks", () => {
    const board = kanban({
      id: "kanban-1",
      plans: {
        "plan-1": workflowPlan({
          id: "plan-1",
          body: { type: "workflow", steps: [existingStep("workspace-1")] },
        }),
      },
    });

    const index = resolveKanbanWorkspaceColumns("server-1", board);

    expect(index.get("workspace-not-tracked")).toBeUndefined();
  });
});

describe("splitWorkspacesByKanbanColumn", () => {
  it("groups workspaces in board order and puts the rest in Unbounded", () => {
    const workspaces = [
      workspaceEntry({ workspaceKey: "server-1:workspace-1", name: "b-workspace" }),
      workspaceEntry({ workspaceKey: "server-1:workspace-2", name: "a-workspace" }),
      workspaceEntry({ workspaceKey: "server-1:workspace-3", name: "unbounded-workspace" }),
    ];
    const refByWorkspaceKey = new Map([
      [
        "server-1:workspace-1",
        {
          serverId: "server-1",
          kanbanId: "kanban-1",
          kanbanName: "Kanban",
          columnId: "inProgress",
          columnName: "In progress",
          columnOrder: 1,
          planId: "plan-1",
          planTitle: "Plan",
        },
      ],
      [
        "server-1:workspace-2",
        {
          serverId: "server-1",
          kanbanId: "kanban-1",
          kanbanName: "Kanban",
          columnId: "draft",
          columnName: "Backlog",
          columnOrder: 0,
          planId: "plan-2",
          planTitle: "Plan 2",
        },
      ],
    ]);

    const { columnGroups, unboundedWorkspaces } = splitWorkspacesByKanbanColumn(
      workspaces,
      refByWorkspaceKey,
    );

    expect(columnGroups.map((group) => group.columnName)).toEqual(["Backlog", "In progress"]);
    expect(columnGroups[0]?.rows.map((row) => row.workspaceKey)).toEqual(["server-1:workspace-2"]);
    expect(unboundedWorkspaces.map((row) => row.workspaceKey)).toEqual(["server-1:workspace-3"]);
  });

  it("puts every workspace in Unbounded when no kanban tracks any of them", () => {
    const workspaces = [workspaceEntry({ workspaceKey: "server-1:workspace-1" })];

    const { columnGroups, unboundedWorkspaces } = splitWorkspacesByKanbanColumn(
      workspaces,
      new Map(),
    );

    expect(columnGroups).toEqual([]);
    expect(unboundedWorkspaces).toHaveLength(1);
  });
});
