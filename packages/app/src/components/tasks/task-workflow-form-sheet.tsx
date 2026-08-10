import { useCallback, useMemo, useSyncExternalStore, type ReactElement } from "react";
import { Text, View } from "react-native";
import { Plus } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import type { Step } from "@getpaseo/protocol/tasks/workflow";
import { useTaskMutations } from "@/tasks/use-tasks";
import { buildTaskWorkflowSteps } from "@/tasks/task-workflow-form-model";
import { useTaskWorkflowFormModel } from "@/tasks/use-task-workflow-form-model";
import { useKanbanProjectCwd } from "@/tasks/use-kanban-project-cwd";
import { toErrorMessage } from "@/utils/error-messages";
import { TaskWorkflowStepEditor } from "./task-workflow-step-editor";

export interface TaskWorkflowFormSheetProps {
  serverId: string;
  taskId: string;
  paseoProjectId?: string | null;
  /** The workflow already on the task, so editing starts from it. */
  existingSteps?: readonly Step[];
  visible: boolean;
  onClose: () => void;
}

function openKey(props: TaskWorkflowFormSheetProps): string {
  return `${props.serverId}:${props.taskId}`;
}

export function TaskWorkflowFormSheet(props: TaskWorkflowFormSheetProps): ReactElement | null {
  if (!props.visible) {
    return null;
  }
  return <OpenTaskWorkflowFormSheet key={openKey(props)} {...props} />;
}

function OpenTaskWorkflowFormSheet({
  serverId,
  taskId,
  paseoProjectId,
  existingSteps,
  visible,
  onClose,
}: TaskWorkflowFormSheetProps): ReactElement {
  const { setWorkflow, isBusy } = useTaskMutations(serverId);
  const cwd = useKanbanProjectCwd(serverId, paseoProjectId);
  const snapshot = useMemo(
    () => ({ serverId, taskId, cwd, ...(existingSteps ? { existingSteps } : {}) }),
    [cwd, existingSteps, serverId, taskId],
  );
  const model = useTaskWorkflowFormModel(snapshot);
  const state = useSyncExternalStore(model.subscribe, model.getState, model.getState);
  const canSubmit = state.canSubmit && !isBusy;

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) {
      return;
    }
    const steps = buildTaskWorkflowSteps(state);
    if (!steps) {
      return;
    }
    model.setSubmitError(null);
    try {
      await setWorkflow({ taskId: state.taskId, steps });
      onClose();
    } catch (submitError) {
      model.setSubmitError(toErrorMessage(submitError));
    }
  }, [canSubmit, model, onClose, setWorkflow, state]);

  const handleSubmitPress = useCallback(() => {
    void handleSubmit();
  }, [handleSubmit]);
  const handleAutoContinue = useCallback((value: boolean) => model.setAutoContinue(value), [model]);

  const header = useMemo(() => ({ title: "Agent plan" }), []);
  const footer = useMemo(
    () => (
      <Button
        variant="default"
        onPress={handleSubmitPress}
        disabled={!canSubmit}
        loading={isBusy}
        testID="task-workflow-form-submit"
      >
        Save plan
      </Button>
    ),
    [canSubmit, handleSubmitPress, isBusy],
  );

  return (
    <AdaptiveModalSheet
      header={header}
      visible={visible}
      onClose={onClose}
      testID="task-workflow-form-sheet"
      footer={footer}
    >
      <View style={styles.form}>
        <View style={styles.continuation} testID="task-workflow-form-auto-continue">
          <View style={styles.continuationCopy}>
            <Text style={styles.continuationTitle}>Continue automatically</Text>
            <Text style={styles.continuationHint}>
              Start each next step when the previous step succeeds. Turn this off to pause between
              steps.
            </Text>
          </View>
          <Switch
            value={state.autoContinue}
            onValueChange={handleAutoContinue}
            accessibilityLabel="Continue automatically"
            testID="task-workflow-form-auto-continue-switch"
          />
        </View>
        {/* Above the list, not below it: a step editor is tall enough that one
            step already fills the sheet, so an Add button after the last one
            starts below the fold and walks further away with every step. */}
        <View style={styles.stepsHeader}>
          <Text style={styles.stepsHeading}>
            {state.steps.length} {state.steps.length === 1 ? "step" : "steps"}
          </Text>
          <Button
            variant="ghost"
            size="sm"
            leftIcon={Plus}
            onPress={model.addStep}
            testID="task-workflow-form-add-step"
          >
            Add step
          </Button>
        </View>
        <View style={styles.steps}>
          {state.steps.map((step, index) => (
            <TaskWorkflowStepEditor
              key={step.key}
              step={step}
              index={index}
              stepCount={state.steps.length}
              state={state}
              model={model}
            />
          ))}
        </View>
        {state.submitError ? (
          <Text style={styles.error} testID="task-workflow-form-error">
            {state.submitError}
          </Text>
        ) : null}
      </View>
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  form: {
    gap: theme.spacing[4],
    paddingHorizontal: theme.spacing[4],
    paddingTop: theme.spacing[2],
    paddingBottom: theme.spacing[4],
  },
  steps: {
    gap: theme.spacing[3],
  },
  continuation: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[4],
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface1,
    padding: theme.spacing[3],
  },
  continuationCopy: {
    minWidth: 0,
    flex: 1,
    gap: theme.spacing[1],
  },
  continuationTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  continuationHint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  stepsHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: -theme.spacing[2],
  },
  stepsHeading: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  error: {
    color: theme.colors.statusDanger,
    fontSize: theme.fontSize.sm,
  },
}));
