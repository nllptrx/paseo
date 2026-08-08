import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { TaskStatus } from "@getpaseo/protocol/tasks/types";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { useToast } from "@/contexts/toast-context";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import {
  selectProjectBoard,
  selectTrackerProjectBoard,
  type TaskDependencyEdge,
} from "@/tasks/task-views";
import { useTaskMutations, useTasks, useTasksSupported } from "@/tasks/use-tasks";
import { toErrorMessage } from "@/utils/error-messages";
import type { TaskWorkflow } from "@getpaseo/protocol/tasks/workflow";
import { NewTaskSheet } from "./new-task-sheet";
import { StartWorkSheet } from "./start-work-sheet";
import { TaskBoard, type TaskBoardMove } from "./task-board";
import { TaskDetailSheet } from "./task-detail-sheet";

const EMPTY_DEPENDENCIES: TaskDependencyEdge[] = [];
const EMPTY_WORKFLOWS: TaskWorkflow[] = [];

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
 * The kanban board's content: this project's tasks by status, capture on every
 * column, moves written straight through to the daemon.
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
  const { moveTask, reviewTask, deleteTask } = useTaskMutations(serverId);
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
  const projectsById = useMemo(
    () => new Map(board.projects.map((project) => [project.id, project])),
    [board.projects],
  );

  // The move lands first and stays landed: someone who drags a card to Working
  // has said where the work is, and that statement must not depend on what they
  // answer next. The chooser only decides whether anything starts, and only for
  // a card that is arriving — reordering inside Working is not a new decision to
  // start something.
  const handleMoveTask = useCallback(
    (move: TaskBoardMove) => {
      const moved = board.tasks.find((task) => task.id === move.taskId);
      const arriving =
        move.status === "in_progress" &&
        moved !== undefined &&
        moved.status !== "in_progress" &&
        moved.agents.length === 0;
      void moveTask(move)
        .then(() => {
          // Only once the move is written: a chooser for a status change that
          // failed would start work the board never agreed to.
          if (arriving) {
            setStartingTaskId(move.taskId);
          }
          return undefined;
        })
        .catch((moveError) => {
          toast.show(toErrorMessage(moveError));
        });
    },
    [board.tasks, moveTask, toast],
  );
  const handleCloseStartWork = useCallback(() => setStartingTaskId(null), []);

  const handleCreateTask = useCallback((status: TaskStatus) => {
    setCapturingStatus(status);
  }, []);

  const handleReviewTask = useCallback(
    (input: { taskId: string; verdict: "approve" | "reject" }) => {
      void reviewTask(input).catch((reviewError) => {
        toast.show(toErrorMessage(reviewError));
      });
    },
    [reviewTask, toast],
  );

  const handleDeleteTask = useCallback(
    (taskId: string) => {
      void deleteTask(taskId).catch((deleteError) => {
        toast.show(toErrorMessage(deleteError));
      });
    },
    [deleteTask, toast],
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
      <TaskBoard
        serverId={serverId}
        tasks={board.tasks}
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
      />
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
