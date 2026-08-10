import type { AgentLifecycleStatus } from "@getpaseo/protocol/agent-lifecycle";
import {
  deriveAgentStateBucket,
  type WorkspaceStateBucket,
} from "@getpaseo/protocol/agent-state-bucket";
import type { Task, TaskAgentLink } from "@getpaseo/protocol/tasks/types";

export type TaskExecutionState = WorkspaceStateBucket | "starting" | "step_complete";

export const TASK_EXECUTION_STATE_ORDER: readonly TaskExecutionState[] = [
  "needs_input",
  "failed",
  "starting",
  "running",
  "attention",
  "step_complete",
  "done",
];

export const TASK_EXECUTION_STATE_LABELS: Record<TaskExecutionState, string> = {
  needs_input: "Needs input",
  failed: "Failed",
  starting: "Starting",
  running: "Working",
  attention: "Ready to review",
  step_complete: "Step complete",
  done: "Done",
};

export interface TaskExecutionAgentSource {
  id: string;
  provider: string;
  title: string | null;
  status: AgentLifecycleStatus;
  pendingPermissionCount: number;
  requiresAttention: boolean;
  attentionReason: "finished" | "error" | "permission" | null;
}

export interface TaskExecutionWorkspaceSource {
  id: string;
  name: string;
  title: string | null;
  branch: string | null;
  pullRequestNumber: number | null;
}

export type TaskExecutionTaskSource = Pick<Task, "id" | "status"> & {
  agents: readonly TaskAgentLink[];
};

export interface TaskExecutionEntry {
  agentId: string;
  workspaceId: string;
  provider: string;
  title: string | null;
  role: "worker" | "reviewer";
  state: TaskExecutionState;
  workspaceName: string;
  branch: string | null;
  pullRequestNumber: number | null;
}

export type TaskExecutionCounts = Record<TaskExecutionState, number>;

export interface TaskExecutionSummary {
  totalCount: number;
  counts: TaskExecutionCounts;
  entries: TaskExecutionEntry[];
}

export interface TaskExecutionWorkspaceGroup {
  workspaceId: string;
  workspaceName: string;
  branch: string | null;
  pullRequestNumber: number | null;
  entries: TaskExecutionEntry[];
}

export interface UntrackedTaskExecutionAgentSource extends TaskExecutionAgentSource {
  workspaceId: string | null;
  parentAgentId: string | null;
  archived: boolean;
  updatedAtMs: number;
}

export interface UntrackedTaskExecutionWorkspaceSource extends TaskExecutionWorkspaceSource {
  projectId: string;
}

function emptyCounts(): TaskExecutionCounts {
  return {
    needs_input: 0,
    failed: 0,
    starting: 0,
    running: 0,
    attention: 0,
    step_complete: 0,
    done: 0,
  };
}

export function resolveTaskExecutionState(agent: TaskExecutionAgentSource): TaskExecutionState {
  const bucket = deriveAgentStateBucket(agent);
  return agent.status === "initializing" && bucket === "done" ? "starting" : bucket;
}

function executionEntry(input: {
  link: TaskAgentLink;
  taskStatus: Task["status"];
  agent: TaskExecutionAgentSource | undefined;
  workspace: TaskExecutionWorkspaceSource | undefined;
}): TaskExecutionEntry {
  const { link, agent, workspace } = input;
  const agentState = agent ? resolveTaskExecutionState(agent) : "starting";
  const state =
    agentState === "attention" &&
    input.taskStatus === "in_progress" &&
    (link.role ?? "worker") === "worker" &&
    link.completionOwner === "workflow"
      ? "step_complete"
      : agentState;
  return {
    agentId: link.agentId,
    workspaceId: link.workspaceId,
    provider: agent?.provider ?? "agent",
    title: agent?.title ?? null,
    role: link.role ?? "worker",
    state,
    workspaceName: workspace?.title ?? workspace?.name ?? "Workspace",
    branch: workspace?.branch ?? null,
    pullRequestNumber: workspace?.pullRequestNumber ?? null,
  };
}

export function buildTaskExecutionSummaries(input: {
  tasks: readonly TaskExecutionTaskSource[];
  agents: ReadonlyMap<string, TaskExecutionAgentSource>;
  workspaces: ReadonlyMap<string, TaskExecutionWorkspaceSource>;
}): ReadonlyMap<string, TaskExecutionSummary> {
  const summaries = new Map<string, TaskExecutionSummary>();
  for (const task of input.tasks) {
    const counts = emptyCounts();
    const entries = task.agents.map((link) =>
      executionEntry({
        link,
        taskStatus: task.status,
        agent: input.agents.get(link.agentId),
        workspace: input.workspaces.get(link.workspaceId),
      }),
    );
    for (const entry of entries) {
      counts[entry.state] += 1;
    }
    summaries.set(task.id, { totalCount: entries.length, counts, entries });
  }
  return summaries;
}

export function groupTaskExecutionsByWorkspace(
  summary: TaskExecutionSummary | null | undefined,
): TaskExecutionWorkspaceGroup[] {
  if (!summary) return [];
  const groups = new Map<string, TaskExecutionWorkspaceGroup>();
  for (const entry of summary.entries) {
    const existing = groups.get(entry.workspaceId);
    if (existing) {
      existing.entries.push(entry);
      continue;
    }
    groups.set(entry.workspaceId, {
      workspaceId: entry.workspaceId,
      workspaceName: entry.workspaceName,
      branch: entry.branch,
      pullRequestNumber: entry.pullRequestNumber,
      entries: [entry],
    });
  }
  return [...groups.values()];
}

/** Standalone root agents stay visible beside the board until a task claims
 * their exact agent id. Child agents remain represented through their parent
 * task/workspace rather than becoming a second capture queue. */
export function selectUntrackedTaskExecutions(input: {
  paseoProjectId: string;
  linkedAgentIds: ReadonlySet<string>;
  agents: readonly UntrackedTaskExecutionAgentSource[];
  workspaces: ReadonlyMap<string, UntrackedTaskExecutionWorkspaceSource>;
}): TaskExecutionEntry[] {
  return input.agents
    .flatMap((agent): Array<TaskExecutionEntry & { updatedAtMs: number }> => {
      if (
        agent.archived ||
        agent.parentAgentId !== null ||
        agent.workspaceId === null ||
        input.linkedAgentIds.has(agent.id)
      ) {
        return [];
      }
      const workspace = input.workspaces.get(agent.workspaceId);
      if (!workspace || workspace.projectId !== input.paseoProjectId) {
        return [];
      }
      return [
        {
          agentId: agent.id,
          workspaceId: workspace.id,
          provider: agent.provider,
          title: agent.title,
          role: "worker",
          state: resolveTaskExecutionState(agent),
          workspaceName: workspace.title ?? workspace.name,
          branch: workspace.branch,
          pullRequestNumber: workspace.pullRequestNumber,
          updatedAtMs: agent.updatedAtMs,
        },
      ];
    })
    .sort((left, right) => {
      const stateOrder =
        TASK_EXECUTION_STATE_ORDER.indexOf(left.state) -
        TASK_EXECUTION_STATE_ORDER.indexOf(right.state);
      return stateOrder === 0 ? right.updatedAtMs - left.updatedAtMs : stateOrder;
    })
    .map(({ updatedAtMs: _updatedAtMs, ...entry }) => entry);
}
