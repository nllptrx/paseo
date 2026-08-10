import { useCallback, useMemo, useState, type ReactElement } from "react";
import { ScrollView, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { Kanban } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import invariant from "tiny-invariant";
import { TaskBoardSurface } from "@/components/tasks/task-board-surface";
import { TaskWorkflowFormSheet } from "@/components/tasks/task-workflow-form-sheet";
import { usePaneContext } from "@/panels/pane-context";
import { useTasks } from "@/tasks/use-tasks";
import type { PanelDescriptor, PanelRegistration } from "@/panels/panel-registry";
import { useWorkspaceFields } from "@/stores/session-store-hooks";
import type { Step } from "@getpaseo/protocol/tasks/workflow";

function useKanbanPanelDescriptor(
  _target: { kind: "kanban" },
  context: { serverId: string; workspaceId: string },
): PanelDescriptor {
  const { t } = useTranslation();
  const projectName = useWorkspaceFields(
    context.serverId,
    context.workspaceId,
    (workspace) => workspace.projectDisplayName,
  );
  const label = t("kanban.panel.label");
  return {
    label,
    subtitle: projectName ?? label,
    tooltip: projectName ?? label,
    titleState: "ready",
    icon: Kanban,
    statusBucket: null,
  };
}

/**
 * The project's task board as a workspace tab: the same surface the board
 * screen shows, one keystroke from the work it tracks.
 */
function KanbanPanel(): ReactElement {
  const { t } = useTranslation();
  const { serverId, workspaceId, target } = usePaneContext();
  invariant(target.kind === "kanban", "KanbanPanel requires kanban target");

  const workspace = useWorkspaceFields(serverId, workspaceId, (fields) => ({
    projectId: fields.projectId,
    projectDisplayName: fields.projectDisplayName,
  }));
  const [workflowTaskId, setWorkflowTaskId] = useState<string | null>(null);
  const [workflowEditSteps, setWorkflowEditSteps] = useState<readonly Step[] | undefined>();

  const handleCreateWorkflowForTask = useCallback(
    (taskId: string, existingSteps?: readonly Step[]) => {
      setWorkflowTaskId(taskId);
      setWorkflowEditSteps(existingSteps);
    },
    [],
  );
  const handleCloseWorkflowForm = useCallback(() => {
    setWorkflowTaskId(null);
    setWorkflowEditSteps(undefined);
  }, []);
  const { snapshot } = useTasks(serverId);
  // Waiting for the snapshot is not the same as having no workflow, and the
  // editor builds its form once — opening it early offers an empty create form
  // that would replace whatever the card already has.
  const workflowSteps = useMemo(() => {
    if (workflowEditSteps !== undefined) {
      return workflowEditSteps;
    }
    if (!workflowTaskId || !snapshot) {
      return undefined;
    }
    return snapshot.workflows?.find((entry) => entry.taskId === workflowTaskId)?.steps ?? [];
  }, [snapshot, workflowEditSteps, workflowTaskId]);

  if (!workspace) {
    return (
      <View style={styles.centered} testID="kanban-panel">
        <Text style={styles.emptyText}>{t("kanban.screen.boardMissing")}</Text>
      </View>
    );
  }

  return (
    <View style={styles.container} testID="kanban-panel">
      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
        <TaskBoardSurface
          serverId={serverId}
          paseoProjectId={workspace.projectId}
          projectDisplayName={workspace.projectDisplayName}
          onCreateWorkflowForTask={handleCreateWorkflowForTask}
        />
      </ScrollView>
      {workflowTaskId && workflowSteps !== undefined ? (
        <TaskWorkflowFormSheet
          serverId={serverId}
          taskId={workflowTaskId}
          paseoProjectId={workspace.projectId}
          existingSteps={workflowSteps}
          visible
          onClose={handleCloseWorkflowForm}
        />
      ) : null}
    </View>
  );
}

export const kanbanPanelRegistration: PanelRegistration<"kanban"> = {
  kind: "kanban",
  component: KanbanPanel,
  useDescriptor: useKanbanPanelDescriptor,
};

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    minHeight: 0,
    backgroundColor: theme.colors.surface0,
  },
  scroll: {
    flex: 1,
    minHeight: 0,
  },
  scrollContent: {
    flexGrow: 1,
  },
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[6],
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
}));
