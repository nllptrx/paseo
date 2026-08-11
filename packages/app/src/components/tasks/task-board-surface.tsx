import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { Kanban, ListTodo, MessagesSquare } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import type { Task, TaskProject, TaskSnapshot, TaskStatus } from "@getpaseo/protocol/tasks/types";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { useToast } from "@/contexts/toast-context";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import {
  filterTasks,
  buildTaskRelationshipSummaries,
  selectBlockers,
  selectProjectBoard,
  selectTrackerProjectBoard,
  sortTasks,
  type TaskDependencyEdge,
  type ProjectBoardSelection,
} from "@/tasks/task-views";
import { useTaskMutations, useTasks, useTasksSupported } from "@/tasks/use-tasks";
import { useTaskStepActions } from "@/tasks/use-task-workflow";
import { toErrorMessage } from "@/utils/error-messages";
import type { Step, TaskWorkflow } from "@getpaseo/protocol/tasks/workflow";
import { NewTaskSheet } from "./new-task-sheet";
import { TaskBoard, type TaskBoardMove } from "./task-board";
import { TaskList } from "./task-list";
import { TaskSurfaceToolbar } from "./task-surface-toolbar";
import {
  DEFAULT_TASK_SURFACE_PREFERENCES,
  useTaskSurfacePreferencesStore,
  type TaskSurfacePreferences,
} from "@/stores/task-surface-preferences-store";
import { confirmDialog } from "@/utils/confirm-dialog";
import { TaskDetailSheet } from "./task-detail-sheet";
import type { TaskDetailSubSurface } from "./task-detail-sheet.logic";
import { useTaskExecutionSummaries, useUntrackedTaskExecutions } from "@/tasks/use-task-execution";
import type { TaskExecutionEntry } from "@/tasks/task-execution";
import { UntrackedTaskWork } from "./untracked-task-work";
import { TaskThreads } from "./task-threads";

const EMPTY_DEPENDENCIES: TaskDependencyEdge[] = [];
const EMPTY_WORKFLOWS: TaskWorkflow[] = [];
const PLAN_SUB_SURFACE: TaskDetailSubSurface = { kind: "plan" };

function selectVisibleBoardTasks(
  board: ProjectBoardSelection,
  preferences: TaskSurfacePreferences,
): Task[] {
  const filtered = filterTasks({
    tasks: board.tasks,
    labels: board.labels,
    filters: {
      statuses: preferences.statuses,
      priorities: preferences.priorities,
      labelNames: preferences.labelNames,
    },
  });
  const query = preferences.query.trim().toLocaleLowerCase();
  if (query.length === 0) return sortTasks(filtered, preferences.sort);
  const matching = filtered.filter((task) => {
    const project = board.projects.find((entry) => entry.id === task.projectId);
    const key = project ? `${project.prefix}-${task.number}` : String(task.number);
    return `${key} ${task.title} ${task.description}`.toLocaleLowerCase().includes(query);
  });
  return sortTasks(matching, preferences.sort);
}

function hasActiveTaskProjection(preferences: TaskSurfacePreferences): boolean {
  if (preferences.sort !== "manual" || preferences.query.trim().length > 0) return true;
  return (
    preferences.statuses.length > 0 ||
    preferences.priorities.length > 0 ||
    preferences.labelNames.length > 0
  );
}

function renderKanbanIcon({ color, size }: { color: string; size: number }): ReactElement {
  return <Kanban color={color} size={size} />;
}

function renderTaskListIcon({ color, size }: { color: string; size: number }): ReactElement {
  return <ListTodo color={color} size={size} />;
}

function renderThreadsIcon({ color, size }: { color: string; size: number }): ReactElement {
  return <MessagesSquare color={color} size={size} />;
}

export interface TaskBoardSurfaceProps {
  serverId: string;
  /** The Paseo project this board belongs to; tasks come from the tracker
   * projects linked to it. Ignored when `trackerProjectId` names one directly. */
  paseoProjectId: string;
  /** The board itself, when the caller already knows which tracker project it
   * is — a board can exist before any checkout does. */
  trackerProjectId?: string | undefined;
  /** Prefills the tracker project the first capture creates. */
  projectDisplayName: string;
  /** Offered on every card when the host screen can author a plan for a task. */
  onCreateWorkflowForTask?: (taskId: string, existingSteps?: readonly Step[]) => void;
  /** Lets a surface outside the board — the feed, which sits beside it — open a
   * task here rather than mounting a second detail sheet of its own. */
  requestedTaskId?: string | null | undefined;
  onRequestedTaskHandled?: (() => void) | undefined;
}

/**
 * One project's task surface: kanban columns or a dense status-grouped list,
 * with every mutation written straight through to the daemon.
 */
export function TaskBoardSurface({
  serverId,
  paseoProjectId,
  trackerProjectId,
  projectDisplayName,
  onCreateWorkflowForTask,
  requestedTaskId,
  onRequestedTaskHandled,
}: TaskBoardSurfaceProps): ReactElement {
  const { t } = useTranslation();
  const toast = useToast();
  const supported = useTasksSupported(serverId);
  const { snapshot, isLoading, isError, error, refetch } = useTasks(serverId);
  const { moveTask, reviewTask, startReview, deleteTask, setPriority, attachAgent } =
    useTaskMutations(serverId);
  const { act } = useTaskStepActions(serverId);
  const [selectedColumn, setSelectedColumn] = useState<TaskStatus>("backlog");
  const [capturingStatus, setCapturingStatus] = useState<TaskStatus | null>(null);
  const [capturingAgent, setCapturingAgent] = useState<TaskExecutionEntry | null>(null);
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);
  const [openTaskSubSurface, setOpenTaskSubSurface] = useState<TaskDetailSubSurface | null>(null);

  const board = useMemo(
    () =>
      trackerProjectId
        ? selectTrackerProjectBoard(snapshot, trackerProjectId)
        : selectProjectBoard(snapshot, paseoProjectId),
    [paseoProjectId, snapshot, trackerProjectId],
  );
  const preferenceScope = `${serverId}:${trackerProjectId ?? `paseo:${paseoProjectId}`}`;
  const preferences = useTaskSurfacePreferencesStore(
    (state) => state.byScope[preferenceScope] ?? DEFAULT_TASK_SURFACE_PREFERENCES,
  );
  const patchPreferences = useTaskSurfacePreferencesStore((state) => state.patchScope);
  const clearFilters = useTaskSurfacePreferencesStore((state) => state.clearFilters);
  const visibleTasks = useMemo(
    () => selectVisibleBoardTasks(board, preferences),
    [board, preferences],
  );
  const executionByTaskId = useTaskExecutionSummaries(serverId, board.tasks);
  const untrackedExecutions = useUntrackedTaskExecutions(
    serverId,
    paseoProjectId,
    snapshot?.tasks ?? [],
  );
  const relationshipsByTaskId = useMemo(
    () =>
      buildTaskRelationshipSummaries({
        tasks: board.tasks,
        dependencies: snapshot?.dependencies ?? EMPTY_DEPENDENCIES,
      }),
    [board.tasks, snapshot?.dependencies],
  );
  const isReorderDisabled = hasActiveTaskProjection(preferences);
  // The board as it is now, for continuations that resolve after a request and
  // must not act on the state that started it.
  const tasksRef = useRef(board.tasks);
  tasksRef.current = board.tasks;
  const workflowsRef = useRef<readonly TaskWorkflow[]>(EMPTY_WORKFLOWS);
  workflowsRef.current = snapshot?.workflows ?? EMPTY_WORKFLOWS;
  const dependenciesRef = useRef<readonly TaskDependencyEdge[]>(EMPTY_DEPENDENCIES);
  dependenciesRef.current = snapshot?.dependencies ?? EMPTY_DEPENDENCIES;

  const projectsById = useMemo(
    () => new Map(board.projects.map((project) => [project.id, project])),
    [board.projects],
  );
  const viewOptions = useMemo(
    () => [
      {
        value: "kanban" as const,
        label: t("kanban.panel.label"),
        icon: renderKanbanIcon,
        testID: "task-view-kanban",
      },
      {
        value: "tasks" as const,
        label: t("tasks.screen.title"),
        icon: renderTaskListIcon,
        testID: "task-view-list",
      },
      {
        value: "threads" as const,
        label: t("tasks.threads.title"),
        icon: renderThreadsIcon,
        testID: "task-view-threads",
      },
    ],
    [t],
  );
  const handlePatchPreferences = useCallback(
    (patch: Parameters<typeof patchPreferences>[1]) => patchPreferences(preferenceScope, patch),
    [patchPreferences, preferenceScope],
  );
  const handleClearFilters = useCallback(
    () => clearFilters(preferenceScope),
    [clearFilters, preferenceScope],
  );
  const handleScrollOffsetChange = useCallback(
    (scrollOffset: number) => patchPreferences(preferenceScope, { scrollOffset }),
    [patchPreferences, preferenceScope],
  );
  const handleCreateBacklogTask = useCallback(() => {
    setCapturingAgent(null);
    setCapturingStatus("backlog");
  }, []);
  const handleSetPriority = useCallback(
    (input: Parameters<typeof setPriority>[0]) => {
      void setPriority(input).catch((priorityError) => toast.show(toErrorMessage(priorityError)));
    },
    [setPriority, toast],
  );

  // A card that arrives in Working with a plan on it offers to run that plan,
  // and asks nothing else: the plan already names the agent, the model and the
  // checkout, so the only open question is whether to start now. A card without
  // one just moves — there is nothing configured to start, and Working is also
  // where someone tracks what they are doing by hand.
  const handleMoveTask = useCallback(
    (move: TaskBoardMove) => {
      const before = tasksRef.current.find((task) => task.id === move.taskId);
      const arriving =
        move.status === "in_progress" && before !== undefined && before.status !== "in_progress";
      void (async () => {
        try {
          await moveTask(move);
        } catch (moveError) {
          toast.show(toErrorMessage(moveError));
          return;
        }
        // Read the card again, not the copy from before the request: moves are
        // not serialised, so by the time this one lands another may have taken
        // the card back out of Working or something may have been started on
        // it. Starting work for a state that no longer holds starts it for
        // nothing.
        const after = tasksRef.current.find((task) => task.id === move.taskId);
        if (!arriving || after?.status !== "in_progress" || after.agents.length > 0) {
          return;
        }
        const firstStep = workflowsRef.current.find((entry) => entry.taskId === move.taskId)
          ?.steps[0];
        if (!firstStep) {
          return;
        }
        // The tracker refuses to start a blocked card, and a refusal that
        // arrives as a bare error reads as a fault rather than an answer.
        const blockers = selectBlockers({
          taskId: move.taskId,
          tasks: tasksRef.current,
          dependencies: dependenciesRef.current,
        });
        if (blockers.length > 0) {
          toast.show(
            t("tasks.start.blocked", { titles: blockers.map((entry) => entry.title).join(", ") }),
          );
          return;
        }
        const confirmed = await confirmDialog({
          title: t("tasks.start.confirmTitle"),
          message: t("tasks.start.confirmMessage", {
            step: firstStep.name,
            agent: firstStep.agents[0]?.model ?? firstStep.agents[0]?.provider ?? "",
          }),
          confirmLabel: t("tasks.start.confirmAction"),
        });
        if (!confirmed) {
          return;
        }
        // The card may have moved on while the dialog was open.
        const current = tasksRef.current.find((task) => task.id === move.taskId);
        if (current?.status !== "in_progress" || current.agents.length > 0) {
          return;
        }
        try {
          await act({ taskId: move.taskId, stepId: firstStep.id, action: "run" });
        } catch (startError) {
          toast.show(toErrorMessage(startError));
        }
      })();
    },
    [act, moveTask, t, toast],
  );

  const handleCreateTask = useCallback((status: TaskStatus) => {
    setCapturingAgent(null);
    setCapturingStatus(status);
  }, []);

  const handleCreateTaskFromAgent = useCallback((entry: TaskExecutionEntry) => {
    setCapturingAgent(entry);
    setCapturingStatus("in_progress");
  }, []);

  const handleAttachTask = useCallback(
    async (input: { taskId: string; agentId: string; workspaceId: string }) => {
      try {
        await attachAgent(input);
      } catch (attachError) {
        toast.show(toErrorMessage(attachError));
      }
    },
    [attachAgent, toast],
  );

  const handleAttachCreatedTask = useCallback(
    (taskId: string) => {
      if (!capturingAgent) return;
      void handleAttachTask({
        taskId,
        agentId: capturingAgent.agentId,
        workspaceId: capturingAgent.workspaceId,
      });
    },
    [capturingAgent, handleAttachTask],
  );

  const handleReviewTask = useCallback(
    (input: { taskId: string; verdict: "approve" | "reject"; feedback?: string }) => {
      void reviewTask(input)
        .then((reviewedTask) => {
          if (input.verdict === "reject" && reviewedTask.status === "in_review") {
            toast.show("The task remains in Review; no correction round was started.");
          }
          return reviewedTask;
        })
        .catch((reviewError) => {
          toast.show(toErrorMessage(reviewError));
        });
    },
    [reviewTask, toast],
  );

  // The board arms the reviewer; the card only says which task is waiting for
  // one. A refusal from the daemon is the whole answer, so it goes to the toast
  // rather than changing the card.
  const handleStartReview = useCallback(
    (taskId: string) => {
      void startReview(taskId).catch((startError) => toast.show(toErrorMessage(startError)));
    },
    [startReview, toast],
  );

  const handleDeleteTask = useCallback(
    (taskId: string) => {
      const task = board.tasks.find((entry) => entry.id === taskId);
      void (async () => {
        const confirmed = await confirmDialog({
          title: t("tasks.board.confirmDeleteTitle"),
          message: t("tasks.board.confirmDeleteMessage", {
            title: task?.title ?? "",
          }),
          confirmLabel: t("tasks.board.delete"),
          destructive: true,
        });
        if (!confirmed) {
          return;
        }
        try {
          await deleteTask(taskId);
        } catch (deleteError) {
          toast.show(toErrorMessage(deleteError));
        }
      })();
    },
    [board.tasks, deleteTask, t, toast],
  );

  const handleOpenAgent = useCallback(
    (input: { workspaceId: string; agentId: string }) => {
      navigateToWorkspace({
        serverId,
        workspaceId: input.workspaceId,
        target: { kind: "agent", agentId: input.agentId },
      });
    },
    [serverId],
  );
  const handleCloseCapture = useCallback(() => {
    setCapturingStatus(null);
    setCapturingAgent(null);
  }, []);
  const handleOpenTask = useCallback((taskId: string) => {
    setOpenTaskId(taskId);
    setOpenTaskSubSurface(null);
  }, []);
  const handleCloseTask = useCallback(() => {
    setOpenTaskId(null);
    setOpenTaskSubSurface(null);
  }, []);
  // "Create & plan" lands on the task it just created with the plan editor
  // already up, so backing out of the editor leaves you on the new card rather
  // than on the board it was captured from.
  const handleCreatedAndPlan = useCallback((taskId: string) => {
    setOpenTaskId(taskId);
    setOpenTaskSubSurface(PLAN_SUB_SURFACE);
  }, []);

  useEffect(() => {
    if (!requestedTaskId) {
      return;
    }
    setOpenTaskId(requestedTaskId);
    onRequestedTaskHandled?.();
  }, [onRequestedTaskHandled, requestedTaskId]);

  if (!supported) {
    return (
      <View style={styles.centered}>
        <Text style={styles.message}>{t("tasks.screen.unsupported")}</Text>
      </View>
    );
  }

  if (isLoading && !snapshot) {
    return (
      <View style={styles.centered}>
        <LoadingSpinner size="small" color={styles.spinner.color} />
      </View>
    );
  }

  if (isError && !snapshot) {
    return (
      <View style={styles.centered}>
        <Text style={styles.errorText}>{toErrorMessage(error)}</Text>
        <Button variant="ghost" size="sm" onPress={refetch} testID="task-board-retry">
          {t("common.actions.retry")}
        </Button>
      </View>
    );
  }

  return (
    <>
      <TaskSurfaceToolbar
        preferences={preferences}
        viewOptions={viewOptions}
        labels={board.labels}
        onPatch={handlePatchPreferences}
        onClearFilters={handleClearFilters}
        onCreateTask={handleCreateBacklogTask}
        reorderDisabled={isReorderDisabled}
      />
      <UntrackedTaskWork
        entries={untrackedExecutions}
        tasks={board.tasks}
        projectsById={projectsById}
        onOpenAgent={handleOpenAgent}
        onCreateTask={handleCreateTaskFromAgent}
        onAttachTask={handleAttachTask}
      />
      {preferences.view === "threads" ? (
        <TaskThreads
          tasks={visibleTasks}
          projectsById={projectsById}
          executionByTaskId={executionByTaskId}
          untracked={untrackedExecutions}
          onOpenAgent={handleOpenAgent}
          onOpenTask={handleOpenTask}
        />
      ) : null}
      {preferences.view === "kanban" ? (
        <TaskBoard
          serverId={serverId}
          tasks={visibleTasks}
          labels={board.labels}
          projectsById={projectsById}
          executionByTaskId={executionByTaskId}
          relationshipsByTaskId={relationshipsByTaskId}
          onMoveTask={handleMoveTask}
          onCreateTask={handleCreateTask}
          onOpenAgent={handleOpenAgent}
          onOpenTask={handleOpenTask}
          onReviewTask={handleReviewTask}
          onStartReview={handleStartReview}
          onDeleteTask={handleDeleteTask}
          onCreateWorkflowForTask={onCreateWorkflowForTask}
          selectedColumn={selectedColumn}
          onSelectColumn={setSelectedColumn}
          expandSubtasks={preferences.expandSubtasks === true}
          dragDisabled={isReorderDisabled}
        />
      ) : null}
      {preferences.view === "tasks" ? (
        <TaskList
          tasks={visibleTasks}
          totalCount={board.tasks.length}
          initialScrollOffset={preferences.scrollOffset ?? 0}
          onScrollOffsetChange={handleScrollOffsetChange}
          labels={board.labels}
          projectsById={projectsById}
          executionByTaskId={executionByTaskId}
          relationshipsByTaskId={relationshipsByTaskId}
          onMoveTask={handleMoveTask}
          onOpenAgent={handleOpenAgent}
          onOpenTask={handleOpenTask}
          onReviewTask={handleReviewTask}
          onStartReview={handleStartReview}
          onDeleteTask={handleDeleteTask}
          onSetPriority={handleSetPriority}
          onCreateWorkflowForTask={onCreateWorkflowForTask}
        />
      ) : null}
      <TaskCaptureSheet
        serverId={serverId}
        project={board.projects[0] ?? null}
        labels={board.labels}
        paseoProjectId={paseoProjectId}
        projectDisplayName={projectDisplayName}
        status={capturingStatus}
        agent={capturingAgent}
        onTaskCreated={handleAttachCreatedTask}
        onCreatedAndPlan={handleCreatedAndPlan}
        onClose={handleCloseCapture}
      />
      <SurfaceTaskDetail
        serverId={serverId}
        paseoProjectId={paseoProjectId}
        openTaskId={openTaskId}
        openTaskSubSurface={openTaskSubSurface}
        snapshot={snapshot}
        tasks={board.tasks}
        labels={board.labels}
        projectsById={projectsById}
        executionByTaskId={executionByTaskId}
        onOpenTask={handleOpenTask}
        onDeleteTask={handleDeleteTask}
        onClose={handleCloseTask}
      />
    </>
  );
}

function TaskCaptureSheet({
  serverId,
  project,
  labels,
  paseoProjectId,
  projectDisplayName,
  status,
  agent,
  onTaskCreated,
  onCreatedAndPlan,
  onClose,
}: {
  serverId: string;
  project: TaskProject | null;
  labels: ProjectBoardSelection["labels"];
  paseoProjectId: string;
  projectDisplayName: string;
  status: TaskStatus | null;
  agent: TaskExecutionEntry | null;
  onTaskCreated: (taskId: string) => void;
  onCreatedAndPlan: (taskId: string) => void;
  onClose: () => void;
}): ReactElement | null {
  if (!status) return null;
  return (
    <NewTaskSheet
      serverId={serverId}
      project={project}
      labels={labels}
      paseoProjectId={paseoProjectId}
      suggestedProjectName={projectDisplayName}
      initialStatus={status}
      initialTitle={agent?.title?.trim() || agent?.workspaceName}
      onTaskCreated={agent ? onTaskCreated : undefined}
      onCreated={onCreatedAndPlan}
      onClose={onClose}
    />
  );
}

function SurfaceTaskDetail({
  serverId,
  paseoProjectId,
  openTaskId,
  openTaskSubSurface,
  snapshot,
  tasks,
  labels,
  projectsById,
  executionByTaskId,
  onOpenTask,
  onDeleteTask,
  onClose,
}: {
  serverId: string;
  paseoProjectId: string;
  openTaskId: string | null;
  openTaskSubSurface: TaskDetailSubSurface | null;
  snapshot: TaskSnapshot | null;
  tasks: readonly Task[];
  labels: ProjectBoardSelection["labels"];
  projectsById: ReadonlyMap<string, TaskProject>;
  executionByTaskId: ReturnType<typeof useTaskExecutionSummaries>;
  onOpenTask: (taskId: string) => void;
  onDeleteTask: (taskId: string) => void;
  onClose: () => void;
}): ReactElement {
  const executionSummary = openTaskId ? executionByTaskId.get(openTaskId) : undefined;
  return (
    <TaskDetailSheet
      serverId={serverId}
      paseoProjectId={paseoProjectId}
      taskId={openTaskId}
      initialSubSurface={openTaskSubSurface}
      tasks={tasks}
      labels={labels}
      projectsById={projectsById}
      dependencies={snapshot?.dependencies ?? EMPTY_DEPENDENCIES}
      workflows={snapshot?.workflows ?? EMPTY_WORKFLOWS}
      executionSummary={executionSummary}
      executionByTaskId={executionByTaskId}
      onOpenTask={onOpenTask}
      onDeleteTask={onDeleteTask}
      onClose={onClose}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  centered: {
    alignItems: "center",
    gap: theme.spacing[2],
    padding: theme.spacing[6],
  },
  message: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
  errorText: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.sm,
  },
  spinner: {
    color: theme.colors.foregroundMuted,
  },
}));
