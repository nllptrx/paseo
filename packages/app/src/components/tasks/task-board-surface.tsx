import { useCallback, useMemo, useState, type ReactElement } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { TaskStatus } from "@getpaseo/protocol/tasks/types";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { useToast } from "@/contexts/toast-context";
import { selectProjectBoard } from "@/tasks/task-views";
import { useTaskMutations, useTasks, useTasksSupported } from "@/tasks/use-tasks";
import { toErrorMessage } from "@/utils/error-messages";
import { NewTaskSheet } from "./new-task-sheet";
import { TaskBoard, type TaskBoardMove } from "./task-board";

export interface TaskBoardSurfaceProps {
  serverId: string;
  /** The Paseo project this board belongs to; tasks come from the tracker
   * projects linked to it. */
  paseoProjectId: string;
  /** Prefills the tracker project the first capture creates. */
  projectDisplayName: string;
}

/**
 * The kanban board's content: this project's tasks by status, capture on every
 * column, moves written straight through to the daemon.
 */
export function TaskBoardSurface({
  serverId,
  paseoProjectId,
  projectDisplayName,
}: TaskBoardSurfaceProps): ReactElement {
  const { t } = useTranslation();
  const toast = useToast();
  const supported = useTasksSupported(serverId);
  const { snapshot, isLoading, isError, error, refetch } = useTasks(serverId);
  const { moveTask } = useTaskMutations(serverId);
  const [selectedColumn, setSelectedColumn] = useState<TaskStatus>("backlog");
  const [capturingStatus, setCapturingStatus] = useState<TaskStatus | null>(null);

  const board = useMemo(
    () => selectProjectBoard(snapshot, paseoProjectId),
    [paseoProjectId, snapshot],
  );
  const projectsById = useMemo(
    () => new Map(board.projects.map((project) => [project.id, project])),
    [board.projects],
  );

  const handleMoveTask = useCallback(
    (move: TaskBoardMove) => {
      void moveTask(move).catch((moveError) => {
        toast.show(toErrorMessage(moveError));
      });
    },
    [moveTask, toast],
  );

  const handleCreateTask = useCallback((status: TaskStatus) => {
    setCapturingStatus(status);
  }, []);
  const handleCloseCapture = useCallback(() => setCapturingStatus(null), []);

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
        tasks={board.tasks}
        labels={board.labels}
        projectsById={projectsById}
        onMoveTask={handleMoveTask}
        onCreateTask={handleCreateTask}
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
          onClose={handleCloseCapture}
        />
      ) : null}
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
