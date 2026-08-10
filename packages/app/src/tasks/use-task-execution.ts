import { useMemo } from "react";
import type { Task } from "@getpaseo/protocol/tasks/types";
import { useSessionStore } from "@/stores/session-store";
import {
  buildTaskExecutionSummaries,
  selectUntrackedTaskExecutions,
  type TaskExecutionAgentSource,
  type TaskExecutionEntry,
  type TaskExecutionSummary,
  type TaskExecutionWorkspaceSource,
  type UntrackedTaskExecutionAgentSource,
  type UntrackedTaskExecutionWorkspaceSource,
} from "./task-execution";

type SessionState = ReturnType<typeof useSessionStore.getState>["sessions"][string] | undefined;

function buildLinkedTaskExecutionSummaries(
  session: SessionState,
  tasks: readonly Pick<Task, "id" | "status" | "agents">[],
): ReadonlyMap<string, TaskExecutionSummary> {
  const agentSources = new Map<string, TaskExecutionAgentSource>();
  const workspaceSources = new Map<string, TaskExecutionWorkspaceSource>();
  for (const task of tasks) {
    for (const link of task.agents) {
      const agent = session?.agents.get(link.agentId);
      if (agent) {
        agentSources.set(link.agentId, {
          id: agent.id,
          provider: agent.provider,
          title: agent.title,
          status: agent.status,
          pendingPermissionCount: agent.pendingPermissions.length,
          requiresAttention: Boolean(agent.requiresAttention),
          attentionReason: agent.attentionReason ?? null,
        });
      }
      const workspace = session?.workspaces.get(link.workspaceId);
      if (workspace) {
        workspaceSources.set(link.workspaceId, {
          id: workspace.id,
          name: workspace.name,
          title: workspace.title ?? null,
          branch: workspace.gitRuntime?.currentBranch ?? null,
          pullRequestNumber: workspace.githubRuntime?.pullRequest?.number ?? null,
        });
      }
    }
  }
  return buildTaskExecutionSummaries({
    tasks,
    agents: agentSources,
    workspaces: workspaceSources,
  });
}

export function useTaskExecutionSummaries(
  serverId: string,
  tasks: readonly Pick<Task, "id" | "status" | "agents">[],
): ReadonlyMap<string, TaskExecutionSummary> {
  const selectSummaries = useMemo(() => {
    let previousAgents: unknown;
    let previousWorkspaces: unknown;
    let previous: ReadonlyMap<string, TaskExecutionSummary> = new Map();
    let initialized = false;

    return (state: ReturnType<typeof useSessionStore.getState>) => {
      const session = state.sessions[serverId];
      if (
        initialized &&
        session?.agents === previousAgents &&
        session?.workspaces === previousWorkspaces
      ) {
        return previous;
      }
      initialized = true;
      previousAgents = session?.agents;
      previousWorkspaces = session?.workspaces;

      previous = buildLinkedTaskExecutionSummaries(session, tasks);
      return previous;
    };
  }, [serverId, tasks]);

  return useSessionStore(selectSummaries);
}

export function useUntrackedTaskExecutions(
  serverId: string,
  paseoProjectId: string,
  tasks: readonly Pick<Task, "agents">[],
): readonly TaskExecutionEntry[] {
  const linkedAgentIds = useMemo(
    () => new Set(tasks.flatMap((task) => task.agents.map((link) => link.agentId))),
    [tasks],
  );
  const selectExecutions = useMemo(() => {
    let previousAgents: unknown;
    let previousWorkspaces: unknown;
    let previous: readonly TaskExecutionEntry[] = [];

    return (state: ReturnType<typeof useSessionStore.getState>) => {
      const session = state.sessions[serverId];
      if (session?.agents === previousAgents && session?.workspaces === previousWorkspaces) {
        return previous;
      }
      previousAgents = session?.agents;
      previousWorkspaces = session?.workspaces;

      const agents: UntrackedTaskExecutionAgentSource[] = [...(session?.agents.values() ?? [])].map(
        (agent) => ({
          id: agent.id,
          provider: agent.provider,
          title: agent.title,
          status: agent.status,
          pendingPermissionCount: agent.pendingPermissions.length,
          requiresAttention: Boolean(agent.requiresAttention),
          attentionReason: agent.attentionReason ?? null,
          workspaceId: agent.workspaceId ?? null,
          parentAgentId: agent.parentAgentId,
          archived: agent.archivedAt != null,
          updatedAtMs: agent.updatedAt.getTime(),
        }),
      );
      const workspaces = new Map<string, UntrackedTaskExecutionWorkspaceSource>();
      for (const workspace of session?.workspaces.values() ?? []) {
        workspaces.set(workspace.id, {
          id: workspace.id,
          projectId: workspace.projectId,
          name: workspace.name,
          title: workspace.title ?? null,
          branch: workspace.gitRuntime?.currentBranch ?? null,
          pullRequestNumber: workspace.githubRuntime?.pullRequest?.number ?? null,
        });
      }
      previous = selectUntrackedTaskExecutions({
        paseoProjectId,
        linkedAgentIds,
        agents,
        workspaces,
      });
      return previous;
    };
  }, [linkedAgentIds, paseoProjectId, serverId]);

  return useSessionStore(selectExecutions);
}
