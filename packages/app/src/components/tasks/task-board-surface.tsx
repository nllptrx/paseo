import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { Kanban, ListTodo } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import type { Task, TaskStatus } from "@getpaseo/protocol/tasks/types";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { useToast } from "@/contexts/toast-context";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import {
  filterTasks,
  selectBlockers,
  selectProjectBoard,
  selectTrackerProjectBoard,
  sortTasks,
  type TaskDependencyEdge,
  type ProjectBoardSelection,
} from "@/tasks/task-views";
import { useTaskMutations, useTasks, useTasksSupported } from "@/tasks/use-tasks";
import { toErrorMessage } from "@/utils/error-messages";
import type { TaskWorkflow } from "@getpaseo/protocol/tasks/workflow";
import { NewTaskSheet } from "./new-task-sheet";
import { StartWorkSheet } from "./start-work-sheet";
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

const EMPTY_DEPENDENCIES: TaskDependencyEdge[] = [];
const EMPTY_WORKFLOWS: TaskWorkflow[] = [];

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
  onCreateWorkflowForTask?: (taskId: string) => void;
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
  const { moveTask, reviewTask, deleteTask, setPriority } = useTaskMutations(serverId);
  const [selectedColumn, setSelectedColumn] = useState<TaskStatus>("backlog");
  const [capturingStatus, setCapturingStatus] = useState<TaskStatus | null>(null);
  const [startingTaskId, setStartingTaskId] = useState<string | null>(null);
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);

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
  const isReorderDisabled = hasActiveTaskProjection(preferences);
  // The board as it is now, for continuations that resolve after a request and
  // must not act on the state that started it.
  const tasksRef = useRef(board.tasks);
  tasksRef.current = board.tasks;

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
  const handleCreateBacklogTask = useCallback(() => setCapturingStatus("backlog"), []);
  const handleSetPriority = useCallback(
    (input: Parameters<typeof setPriority>[0]) => {
      void setPriority(input).catch((priorityError) => toast.show(toErrorMessage(priorityError)));
    },
    [setPriority, toast],
  );

  // The move lands first and stays landed: someone who drags a card to Working
  // has said where the work is, and that statement must not depend on what they
  // answer next. The chooser only decides whether anything starts, and only for
  // a card that is arriving — reordering inside Working is not a new decision to
  // start something.
  const handleMoveTask = useCallback(
    (move: TaskBoardMove) => {
      const before = tasksRef.current.find((task) => task.id === move.taskId);
      const arriving =
        move.status === "in_progress" && before !== undefined && before.status !== "in_progress";
      void moveTask(move)
        .then(() => {
          // Read the card again, not the copy from before the request: moves are
          // not serialised, so by the time this one lands another may have taken
          // the card back out of Working or something may have been started on
          // it. A chooser for a state that no longer holds is a chooser for
          // nothing.
          const after = tasksRef.current.find((task) => task.id === move.taskId);
          if (arriving && after?.status === "in_progress" && after.agents.length === 0) {
            setStartingTaskId(move.taskId);
          }
          return undefined;
        })
        .catch((moveError) => {
          toast.show(toErrorMessage(moveError));
        });
    },
    [moveTask, toast],
  );
  const handleCloseStartWork = useCallback(() => setStartingTaskId(null), []);

  const startingTaskBlockers = useMemo(
    () =>
      startingTaskId
        ? selectBlockers({
            taskId: startingTaskId,
            tasks: board.tasks,
            dependencies: snapshot?.dependencies ?? EMPTY_DEPENDENCIES,
          })
        : [],
    [board.tasks, snapshot?.dependencies, startingTaskId],
  );

  const handleCreateTask = useCallback((status: TaskStatus) => {
    setCapturingStatus(status);
  }, []);

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

  const handleDeleteTask = useCallback(
    (taskId: string) => {
      const task = board.tasks.find((entry) => entry.id === taskId);
      void (async () => {
        const confirmed = await confirmDialog({
          title: t("tasks.board.confirmDeleteTitle"),
          message: t("tasks.board.confirmDeleteMessage", {
            title: task?.title ?? "",
          }),
          confirmLabel: t("common.actions.delete"),
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
  const handleCloseCapture = useCallback(() => setCapturingStatus(null), []);
  // Editing a workflow closes the card it belongs to: the editor is a sheet of
  // its own, and two stacked sheets leave no obvious way back.
  const handleEditWorkflow = useCallback(
    (taskId: string) => {
      setOpenTaskId(null);
      onCreateWorkflowForTask?.(taskId);
    },
    [onCreateWorkflowForTask],
  );
  const handleOpenTask = useCallback((taskId: string) => setOpenTaskId(taskId), []);
  const handleCloseTask = useCallback(() => setOpenTaskId(null), []);

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
        visibleCount={visibleTasks.length}
        totalCount={board.tasks.length}
        onPatch={handlePatchPreferences}
        onClearFilters={handleClearFilters}
        onCreateTask={handleCreateBacklogTask}
        reorderDisabled={isReorderDisabled}
      />
      {preferences.view === "kanban" ? (
        <TaskBoard
          serverId={serverId}
          tasks={visibleTasks}
          labels={board.labels}
          projectsById={projectsById}
          onMoveTask={handleMoveTask}
          onCreateTask={handleCreateTask}
          onOpenAgent={handleOpenAgent}
          onOpenTask={handleOpenTask}
          onReviewTask={handleReviewTask}
          onDeleteTask={handleDeleteTask}
          onCreateWorkflowForTask={onCreateWorkflowForTask}
          selectedColumn={selectedColumn}
          onSelectColumn={setSelectedColumn}
          dragDisabled={isReorderDisabled}
        />
      ) : (
        <TaskList
          serverId={serverId}
          tasks={visibleTasks}
          totalCount={board.tasks.length}
          initialScrollOffset={preferences.scrollOffset ?? 0}
          onScrollOffsetChange={handleScrollOffsetChange}
          labels={board.labels}
          projectsById={projectsById}
          onMoveTask={handleMoveTask}
          onOpenAgent={handleOpenAgent}
          onOpenTask={handleOpenTask}
          onReviewTask={handleReviewTask}
          onDeleteTask={handleDeleteTask}
          onSetPriority={handleSetPriority}
          onCreateWorkflowForTask={onCreateWorkflowForTask}
        />
      )}
      {capturingStatus ? (
        <NewTaskSheet
          serverId={serverId}
          project={board.projects[0] ?? null}
          paseoProjectId={paseoProjectId}
          suggestedProjectName={projectDisplayName}
          initialStatus={capturingStatus}
          onCreated={onCreateWorkflowForTask}
          onClose={handleCloseCapture}
        />
      ) : null}
      <StartWorkSheet
        serverId={serverId}
        task={board.tasks.find((task) => task.id === startingTaskId) ?? null}
        workflow={
          (snapshot?.workflows ?? EMPTY_WORKFLOWS).find(
            (entry) => entry.taskId === startingTaskId,
          ) ?? null
        }
        blockers={startingTaskBlockers}
        onClose={handleCloseStartWork}
      />
      <TaskDetailSheet
        serverId={serverId}
        taskId={openTaskId}
        tasks={board.tasks}
        labels={board.labels}
        projectsById={projectsById}
        dependencies={snapshot?.dependencies ?? EMPTY_DEPENDENCIES}
        workflows={snapshot?.workflows ?? EMPTY_WORKFLOWS}
        onEditWorkflow={handleEditWorkflow}
        onClose={handleCloseTask}
      />
    </>
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
