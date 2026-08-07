import { useCallback, useMemo, useState, type ReactElement } from "react";
import { ScrollView, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { Kanban } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import invariant from "tiny-invariant";
import { KanbanPlanFormSheet } from "@/components/kanban/kanban-plan-form-sheet";
import { TaskBoardSurface } from "@/components/tasks/task-board-surface";
import { useToast } from "@/contexts/toast-context";
import { useKanbans } from "@/hooks/use-kanbans";
import { useKanbanMutations } from "@/hooks/use-kanban-mutations";
import { usePaneContext } from "@/panels/pane-context";
import type { PanelDescriptor, PanelRegistration } from "@/panels/panel-registry";
import { useWorkspaceFields } from "@/stores/session-store-hooks";
import { toErrorMessage } from "@/utils/error-messages";

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
 * The project's task board as a workspace tab: same surface the /kanbans board
 * screen shows, one keystroke from the work it tracks. The plan form resolves
 * its kanban lazily — the record is get-or-create per project, so a project
 * that never authored a plan gets its board only when it first needs one.
 */
function KanbanPanel(): ReactElement {
  const { t } = useTranslation();
  const toast = useToast();
  const { serverId, workspaceId, target } = usePaneContext();
  invariant(target.kind === "kanban", "KanbanPanel requires kanban target");

  const workspace = useWorkspaceFields(serverId, workspaceId, (fields) => ({
    projectId: fields.projectId,
    projectDisplayName: fields.projectDisplayName,
  }));
  const { loadState } = useKanbans();
  const { createKanban } = useKanbanMutations({ serverId });
  const [planForm, setPlanForm] = useState<{ kanbanId: string; taskId: string | null } | null>(
    null,
  );

  const existingKanbanId = useMemo(() => {
    if (loadState.status !== "loaded" || !workspace) {
      return null;
    }
    return (
      loadState.data.find(
        (kanban) =>
          kanban.serverId === serverId &&
          kanban.projectId === workspace.projectId &&
          kanban.archivedAt === null,
      )?.id ?? null
    );
  }, [loadState, serverId, workspace]);

  const handleCreatePlanForTask = useCallback(
    (taskId: string) => {
      void (async () => {
        try {
          const kanbanId =
            existingKanbanId ?? (await createKanban({ projectId: workspace?.projectId ?? "" }));
          setPlanForm({ kanbanId, taskId });
        } catch (error) {
          toast.show(toErrorMessage(error));
        }
      })();
    },
    [createKanban, existingKanbanId, toast, workspace?.projectId],
  );
  const handleCloseCreatePlan = useCallback(() => setPlanForm(null), []);

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
          onCreatePlanForTask={handleCreatePlanForTask}
        />
      </ScrollView>
      {planForm ? (
        <KanbanPlanFormSheet
          serverId={serverId}
          kanbanId={planForm.kanbanId}
          parentPlanId={null}
          taskId={planForm.taskId}
          visible
          onClose={handleCloseCreatePlan}
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
