import { describe, expect, it } from "vitest";
import type { AgentLifecycleStatus } from "@getpaseo/protocol/agent-lifecycle";
import type { TaskAgentLink } from "@getpaseo/protocol/tasks/types";
import {
  buildTaskExecutionSummaries,
  groupTaskExecutionsByWorkspace,
  resolveTaskExecutionState,
  selectUntrackedTaskExecutions,
  type TaskExecutionAgentSource,
  type TaskExecutionTaskSource,
  type TaskExecutionWorkspaceSource,
  type UntrackedTaskExecutionAgentSource,
  type UntrackedTaskExecutionWorkspaceSource,
} from "./task-execution";

function agent(
  id: string,
  input: Partial<TaskExecutionAgentSource> & { status: AgentLifecycleStatus },
): TaskExecutionAgentSource {
  return {
    id,
    provider: "codex",
    title: null,
    pendingPermissionCount: 0,
    requiresAttention: false,
    attentionReason: null,
    ...input,
  };
}

function link(agentId: string, workspaceId: string): TaskAgentLink {
  return {
    agentId,
    workspaceId,
    presetId: null,
    role: "worker",
    completionOwner: "attachment",
    attachedAt: "2026-08-10T10:00:00.000Z",
  };
}

describe("resolveTaskExecutionState", () => {
  it("keeps actionable and live states ahead of settled states", () => {
    expect(
      resolveTaskExecutionState(
        agent("permission", {
          status: "running",
          pendingPermissionCount: 1,
          attentionReason: "error",
        }),
      ),
    ).toBe("needs_input");
    expect(resolveTaskExecutionState(agent("failed", { status: "error" }))).toBe("failed");
    expect(resolveTaskExecutionState(agent("starting", { status: "initializing" }))).toBe(
      "starting",
    );
    expect(resolveTaskExecutionState(agent("working", { status: "running" }))).toBe("running");
    expect(
      resolveTaskExecutionState(
        agent("attention", {
          status: "idle",
          requiresAttention: true,
          attentionReason: "finished",
        }),
      ),
    ).toBe("attention");
    expect(resolveTaskExecutionState(agent("complete", { status: "closed" }))).toBe("done");
  });
});

describe("buildTaskExecutionSummaries", () => {
  it("reads exact task agent links and ignores unrelated agents in the same workspace", () => {
    const tasks: TaskExecutionTaskSource[] = [
      { id: "task-1", agents: [link("attached", "workspace-1")] },
    ];
    const agents = new Map<string, TaskExecutionAgentSource>([
      ["attached", agent("attached", { status: "idle", requiresAttention: true })],
      ["unrelated", agent("unrelated", { status: "error" })],
    ]);
    const workspaces = new Map<string, TaskExecutionWorkspaceSource>([
      [
        "workspace-1",
        {
          id: "workspace-1",
          name: "feature/task-status",
          title: null,
          branch: "feature/task-status",
          pullRequestNumber: 42,
        },
      ],
    ]);

    const summary = buildTaskExecutionSummaries({ tasks, agents, workspaces }).get("task-1");

    expect(summary).toEqual({
      totalCount: 1,
      counts: {
        needs_input: 0,
        failed: 0,
        starting: 0,
        running: 0,
        attention: 1,
        done: 0,
      },
      entries: [
        {
          agentId: "attached",
          workspaceId: "workspace-1",
          provider: "codex",
          title: null,
          role: "worker",
          state: "attention",
          workspaceName: "feature/task-status",
          branch: "feature/task-status",
          pullRequestNumber: 42,
        },
      ],
    });
  });

  it("shows a fresh attachment as starting until its agent record arrives", () => {
    const tasks: TaskExecutionTaskSource[] = [
      { id: "task-1", agents: [link("pending-agent", "workspace-1")] },
    ];

    const summary = buildTaskExecutionSummaries({
      tasks,
      agents: new Map(),
      workspaces: new Map(),
    }).get("task-1");

    expect(summary?.counts.starting).toBe(1);
    expect(summary?.entries[0]?.state).toBe("starting");
  });

  it("groups several attached agents under their execution workspace", () => {
    const tasks: TaskExecutionTaskSource[] = [
      {
        id: "task-1",
        agents: [link("agent-1", "workspace-1"), link("agent-2", "workspace-1")],
      },
    ];
    const agents = new Map<string, TaskExecutionAgentSource>([
      ["agent-1", agent("agent-1", { status: "running" })],
      ["agent-2", agent("agent-2", { status: "idle" })],
    ]);
    const summary = buildTaskExecutionSummaries({ tasks, agents, workspaces: new Map() }).get(
      "task-1",
    );

    expect(groupTaskExecutionsByWorkspace(summary).map((group) => group.entries.length)).toEqual([
      2,
    ]);
  });
});

describe("selectUntrackedTaskExecutions", () => {
  it("shows only standalone root agents in this Paseo project that no task links", () => {
    const agents: UntrackedTaskExecutionAgentSource[] = [
      {
        ...agent("untracked", { status: "running" }),
        workspaceId: "workspace-1",
        parentAgentId: null,
        archived: false,
        updatedAtMs: 20,
      },
      {
        ...agent("linked", { status: "error" }),
        workspaceId: "workspace-1",
        parentAgentId: null,
        archived: false,
        updatedAtMs: 30,
      },
      {
        ...agent("child", { status: "running" }),
        workspaceId: "workspace-1",
        parentAgentId: "untracked",
        archived: false,
        updatedAtMs: 40,
      },
      {
        ...agent("other-project", { status: "running" }),
        workspaceId: "workspace-2",
        parentAgentId: null,
        archived: false,
        updatedAtMs: 50,
      },
    ];
    const workspaces = new Map<string, UntrackedTaskExecutionWorkspaceSource>([
      [
        "workspace-1",
        {
          id: "workspace-1",
          projectId: "project-1",
          name: "feature/task-status",
          title: "Task status",
          branch: "feature/task-status",
          pullRequestNumber: null,
        },
      ],
      [
        "workspace-2",
        {
          id: "workspace-2",
          projectId: "project-2",
          name: "other",
          title: null,
          branch: null,
          pullRequestNumber: null,
        },
      ],
    ]);

    expect(
      selectUntrackedTaskExecutions({
        paseoProjectId: "project-1",
        linkedAgentIds: new Set(["linked"]),
        agents,
        workspaces,
      }),
    ).toEqual([
      expect.objectContaining({
        agentId: "untracked",
        workspaceId: "workspace-1",
        workspaceName: "Task status",
        state: "running",
      }),
    ]);
  });

  it("orders actionable states first and recency within a state", () => {
    const agents = [
      {
        ...agent("older-working", { status: "running" }),
        workspaceId: "workspace-1",
        parentAgentId: null,
        archived: false,
        updatedAtMs: 10,
      },
      {
        ...agent("newer-working", { status: "running" }),
        workspaceId: "workspace-1",
        parentAgentId: null,
        archived: false,
        updatedAtMs: 20,
      },
      {
        ...agent("permission", { status: "running", pendingPermissionCount: 1 }),
        workspaceId: "workspace-1",
        parentAgentId: null,
        archived: false,
        updatedAtMs: 5,
      },
    ] satisfies UntrackedTaskExecutionAgentSource[];
    const workspaces = new Map<string, UntrackedTaskExecutionWorkspaceSource>([
      [
        "workspace-1",
        {
          id: "workspace-1",
          projectId: "project-1",
          name: "workspace",
          title: null,
          branch: null,
          pullRequestNumber: null,
        },
      ],
    ]);

    expect(
      selectUntrackedTaskExecutions({
        paseoProjectId: "project-1",
        linkedAgentIds: new Set(),
        agents,
        workspaces,
      }).map((entry) => entry.agentId),
    ).toEqual(["permission", "newer-working", "older-working"]);
  });
});
