import { useCallback, useMemo } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type {
  Task,
  TaskExecutionPolicy,
  TaskExecutionSpec,
  TaskPriority,
  TaskSnapshot,
  TaskStatus,
} from "@getpaseo/protocol/tasks/types";
import type { StepInput } from "@getpaseo/protocol/tasks/workflow";
import { useFetchQuery } from "@/data/query";
import { tasksPushRoute } from "@/data/push-router";
import { tasksQueryBaseKey, tasksQueryKey } from "@/tasks/task-query-keys";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";

export { tasksQueryBaseKey, tasksQueryKey } from "@/tasks/task-query-keys";

/** The tracker is host-local, and the host says whether it has one at all. */
export function useTasksSupported(serverId: string): boolean {
  return useSessionStore((state) => state.sessions[serverId]?.serverInfo?.features?.tasks === true);
}

/** Per-task automation fields are newer than the tracker itself. */
export function useTaskExecutionPolicySupported(serverId: string): boolean {
  return useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.taskExecutionPolicy === true,
  );
}

/** Explicit persisted messages require recipient delivery metadata. */
export function useTaskMessagesSupported(serverId: string): boolean {
  return useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.taskMessages === true,
  );
}

/** Deleting a project label requires a daemon newer than label creation. */
export function useTaskLabelDeletionSupported(serverId: string): boolean {
  return useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.taskLabelDeletion === true,
  );
}

/**
 * Whether a card sits in Working with nothing that would make it move on its
 * own: no plan, no agent already on it, and no subtasks carrying plans of their
 * own. Working is also where someone tracks what they are doing by hand, so
 * this is an offer on the card and never an interruption.
 */
export function useTaskLacksPlan(serverId: string, task: Task): boolean {
  const { snapshot } = useTasks(serverId);
  return useMemo(() => {
    if (task.status !== "in_progress" || task.agents.length > 0 || !snapshot) {
      return false;
    }
    if (snapshot.workflows?.some((entry) => entry.taskId === task.id)) {
      return false;
    }
    return !snapshot.tasks.some((candidate) => candidate.parentTaskId === task.id);
  }, [snapshot, task]);
}

export interface UseTasksResult {
  snapshot: TaskSnapshot | null;
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  refetch: () => void;
}

export function useTasks(serverId: string): UseTasksResult {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const supported = useTasksSupported(serverId);

  const enabled = Boolean(client && isConnected && supported);
  const query = useFetchQuery({
    queryKey: tasksQueryKey(serverId),
    enabled,
    meta: tasksPushRoute({ enabled, serverIds: [serverId] }),
    dataShape: "value",
    staleTimeMs: 2_000,
    queryFn: async (): Promise<TaskSnapshot | null> => {
      if (!client) {
        throw new Error(t("common.errors.daemonClientUnavailable"));
      }
      const payload = await client.tasksSnapshot();
      if (payload.error) {
        throw new Error(payload.error);
      }
      return payload.snapshot;
    },
  });

  return {
    snapshot: query.data ?? null,
    isLoading: query.isPending && Boolean(client && isConnected && supported),
    isError: query.isError,
    error: query.error,
    refetch: () => {
      void query.refetch();
    },
  };
}

export interface TaskMovePatch {
  taskId: string;
  status: TaskStatus;
  beforePosition: number | null;
  afterPosition: number | null;
}

/** Mirrors the daemon's `POSITION_STEP` arithmetic in the tasks store, so the
 * optimistic paint and the settled write agree and the card does not jump. */
const POSITION_STEP = 1024;

function guessMovePosition(before: number | null, after: number | null): number {
  if (before !== null && after !== null) {
    return (before + after) / 2;
  }
  if (before !== null) {
    return before + POSITION_STEP;
  }
  if (after !== null) {
    return after - POSITION_STEP;
  }
  return POSITION_STEP;
}

function applyMoveToSnapshot(snapshot: TaskSnapshot, move: TaskMovePatch): TaskSnapshot {
  const position = guessMovePosition(move.beforePosition, move.afterPosition);
  const tasks: Task[] = snapshot.tasks.map((task) =>
    task.id === move.taskId ? { ...task, status: move.status, position } : task,
  );
  return { ...snapshot, tasks };
}

export interface UseTaskMutationsResult {
  createProject: (input: {
    name: string;
    prefix: string;
    color: string;
    paseoProjectId?: string | null;
  }) => Promise<string>;
  createLabel: (input: { projectId: string; name: string; color: string }) => Promise<string>;
  deleteLabel: (labelId: string) => Promise<void>;
  /** Resolves with the new task's id: the snapshot has not refetched yet, so a
   * caller that needs to act on the task cannot read it back from there. */
  createTask: (input: {
    projectId: string;
    title: string;
    description?: string;
    status?: TaskStatus;
    parentTaskId?: string | null;
    executionPolicy?: TaskExecutionPolicy;
    executionSpec?: TaskExecutionSpec;
    /** Subtasks chain onto the previous sibling unless this says otherwise. */
    parallel?: boolean;
  }) => Promise<string>;
  attachAgent: (input: {
    taskId: string;
    agentId: string;
    workspaceId: string;
    presetId?: string | null;
  }) => Promise<Task>;
  moveTask: (input: TaskMovePatch) => Promise<void>;
  reviewTask: (input: {
    taskId: string;
    verdict: "approve" | "reject";
    feedback?: string;
  }) => Promise<Task>;
  /** Arms a reviewer for a card that is in review with nobody judging it. */
  startReview: (taskId: string) => Promise<void>;
  updateTask: (input: {
    taskId: string;
    title?: string;
    description?: string;
    status?: TaskStatus;
    priority?: TaskPriority;
    dueDate?: string | null;
    parentTaskId?: string | null;
    labelIds?: string[];
    executionPolicy?: TaskExecutionPolicy | null;
  }) => Promise<Task>;
  configureBoard: (input: {
    projectId: string;
    reviewEnabled?: boolean;
    reviewOnReject?: "in_progress" | "todo" | "backlog";
    archiveWorkspacesOnDone?: boolean;
    reviewerPresetId?: string | null;
    maxReviewIterations?: number;
  }) => Promise<void>;
  setWorkflow: (input: { taskId: string; steps: StepInput[] }) => Promise<void>;
  clearWorkflow: (taskId: string) => Promise<void>;
  runStep: (input: { taskId: string; stepId: string }) => Promise<void>;
  setStatus: (input: { taskId: string; status: TaskStatus }) => Promise<Task>;
  setPriority: (input: {
    taskId: string;
    priority: "urgent" | "high" | "medium" | "low" | "none";
  }) => Promise<Task>;
  deleteTask: (taskId: string) => Promise<void>;
  isReviewing: boolean;
  isBusy: boolean;
}

export function useTaskMutations(serverId: string): UseTaskMutationsResult {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const queryClient = useQueryClient();

  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: tasksQueryKey(serverId) });
  }, [queryClient, serverId]);

  const require = useCallback(() => {
    if (!client) {
      throw new Error(t("common.errors.daemonClientUnavailable"));
    }
    return client;
  }, [client, t]);

  const createProject = useMutation({
    mutationFn: async (input: {
      name: string;
      prefix: string;
      color: string;
      paseoProjectId?: string | null;
    }) => {
      const payload = await require().tasksProjectCreate(input);
      if (payload.error || !payload.project) {
        throw new Error(payload.error ?? "The host created no project");
      }
      return payload.project.id;
    },
    onSettled: invalidate,
  });

  const createTask = useMutation({
    mutationFn: async (input: {
      projectId: string;
      title: string;
      description?: string;
      status?: TaskStatus;
      parentTaskId?: string | null;
      executionPolicy?: TaskExecutionPolicy;
      executionSpec?: TaskExecutionSpec;
      parallel?: boolean;
    }) => {
      const payload = await require().tasksCreate(input);
      if (payload.error || !payload.task) {
        throw new Error(payload.error ?? "The host created no task");
      }
      return payload.task.id;
    },
    onSettled: invalidate,
  });

  const createLabel = useMutation({
    mutationFn: async (input: { projectId: string; name: string; color: string }) => {
      const payload = await require().tasksLabelCreate(input);
      if (payload.error || !payload.labelId) {
        throw new Error(payload.error ?? "The host created no label");
      }
      return payload.labelId;
    },
    onSettled: invalidate,
  });

  const deleteLabel = useMutation({
    mutationFn: async (labelId: string) => {
      const payload = await require().tasksLabelDelete(labelId);
      if (payload.error) {
        throw new Error(payload.error);
      }
    },
    onSettled: invalidate,
  });

  const attachAgent = useMutation({
    mutationFn: async (input: Parameters<DaemonClient["tasksAgentAttach"]>[0]) => {
      const payload = await require().tasksAgentAttach(input);
      if (payload.error || !payload.task) {
        throw new Error(payload.error ?? "The host returned no updated task");
      }
      return payload.task;
    },
    onSettled: invalidate,
  });

  // The card moves the moment it is dropped. The daemon still picks the real
  // position from the neighbours; the refetch on settle reconciles the guess.
  const move = useMutation({
    mutationFn: async (input: TaskMovePatch) => {
      const payload = await require().tasksMove(input);
      if (payload.error) {
        throw new Error(payload.error);
      }
    },
    onMutate: async (input: TaskMovePatch) => {
      await queryClient.cancelQueries({ queryKey: tasksQueryKey(serverId) });
      queryClient.setQueryData<TaskSnapshot | null>(tasksQueryKey(serverId), (snapshot) =>
        snapshot ? applyMoveToSnapshot(snapshot, input) : snapshot,
      );
    },
    onSettled: invalidate,
  });

  const update = useMutation({
    mutationFn: async (input: Parameters<DaemonClient["tasksUpdate"]>[0]) => {
      const payload = await require().tasksUpdate(input);
      if (payload.error || !payload.task) {
        throw new Error(payload.error ?? "The host returned no updated task");
      }
      return payload.task;
    },
    onSettled: invalidate,
  });

  const remove = useMutation({
    mutationFn: async (taskId: string) => {
      const payload = await require().tasksDelete(taskId);
      if (payload.error) {
        throw new Error(payload.error);
      }
    },
    onSettled: invalidate,
  });

  const review = useMutation({
    mutationFn: async (input: {
      taskId: string;
      verdict: "approve" | "reject";
      feedback?: string;
    }) => {
      const payload = await require().tasksReview(input);
      if (payload.error || !payload.task) {
        throw new Error(payload.error ?? "The host returned no reviewed task");
      }
      return payload.task;
    },
    onSettled: invalidate,
  });

  const startReview = useMutation({
    mutationFn: async (taskId: string) => {
      const payload = await require().tasksReviewStart(taskId);
      if (payload.error) {
        throw new Error(payload.error);
      }
    },
    onSettled: invalidate,
  });

  const configureBoard = useMutation({
    mutationFn: async (input: {
      projectId: string;
      reviewEnabled?: boolean;
      reviewOnReject?: "in_progress" | "todo" | "backlog";
      archiveWorkspacesOnDone?: boolean;
      reviewerPresetId?: string | null;
      maxReviewIterations?: number;
    }) => {
      const payload = await require().tasksBoardConfigure(input);
      if (payload.error) {
        throw new Error(payload.error);
      }
    },
    onSettled: invalidate,
  });

  const setWorkflow = useMutation({
    mutationFn: async (input: { taskId: string; steps: StepInput[] }) => {
      const payload = await require().tasksWorkflowSet(input);
      if (payload.error) {
        throw new Error(payload.error);
      }
    },
    onSettled: invalidate,
  });

  const clearWorkflow = useMutation({
    mutationFn: async (taskId: string) => {
      const payload = await require().tasksWorkflowClear(taskId);
      if (payload.error) {
        throw new Error(payload.error);
      }
    },
    onSettled: invalidate,
  });

  const runStep = useMutation({
    mutationFn: async (input: { taskId: string; stepId: string }) => {
      const payload = await require().tasksStepRun(input);
      if (payload.error) {
        throw new Error(payload.error);
      }
    },
    onSettled: invalidate,
  });

  return {
    createProject: (input) => createProject.mutateAsync(input),
    createLabel: (input) => createLabel.mutateAsync(input),
    deleteLabel: (labelId) => deleteLabel.mutateAsync(labelId),
    configureBoard: (input) => configureBoard.mutateAsync(input),
    setWorkflow: (input) => setWorkflow.mutateAsync(input),
    clearWorkflow: (taskId) => clearWorkflow.mutateAsync(taskId),
    runStep: (input) => runStep.mutateAsync(input),
    createTask: (input) => createTask.mutateAsync(input),
    attachAgent: (input) => attachAgent.mutateAsync(input),
    moveTask: (input) => move.mutateAsync(input),
    reviewTask: (input) => review.mutateAsync(input),
    startReview: (taskId) => startReview.mutateAsync(taskId),
    updateTask: (input) => update.mutateAsync(input),
    setStatus: (input) => update.mutateAsync({ taskId: input.taskId, status: input.status }),
    setPriority: (input) => update.mutateAsync({ taskId: input.taskId, priority: input.priority }),
    deleteTask: (taskId) => remove.mutateAsync(taskId),
    isReviewing: review.isPending || startReview.isPending,
    isBusy:
      createProject.isPending ||
      createLabel.isPending ||
      deleteLabel.isPending ||
      createTask.isPending ||
      attachAgent.isPending ||
      update.isPending ||
      move.isPending ||
      review.isPending ||
      startReview.isPending ||
      remove.isPending ||
      configureBoard.isPending ||
      setWorkflow.isPending ||
      clearWorkflow.isPending ||
      runStep.isPending,
  };
}
