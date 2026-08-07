import { useCallback, useMemo, useSyncExternalStore, type ReactElement } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { Plus } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { useTaskMutations } from "@/tasks/use-tasks";
import { buildTaskWorkflowSteps } from "@/tasks/task-workflow-form-model";
import { useTaskWorkflowFormModel } from "@/tasks/use-task-workflow-form-model";
import { toErrorMessage } from "@/utils/error-messages";
import { TaskWorkflowStepEditor } from "./task-workflow-step-editor";

export interface TaskWorkflowFormSheetProps {
  serverId: string;
  taskId: string;
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
  visible,
  onClose,
}: TaskWorkflowFormSheetProps): ReactElement {
  const { t } = useTranslation();
  const { setWorkflow, isBusy } = useTaskMutations(serverId);
  const snapshot = useMemo(() => ({ serverId, taskId }), [serverId, taskId]);
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

  const header = useMemo(() => ({ title: t("tasks.workflow.title") }), [t]);
  const footer = useMemo(
    () => (
      <Button
        variant="default"
        onPress={handleSubmitPress}
        disabled={!canSubmit}
        loading={isBusy}
        testID="task-workflow-form-submit"
      >
        {t("tasks.workflow.submit")}
      </Button>
    ),
    [canSubmit, handleSubmitPress, isBusy, t],
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
        {/* Above the list, not below it: a step editor is tall enough that one
            step already fills the sheet, so an Add button after the last one
            starts below the fold and walks further away with every step. */}
        <View style={styles.stepsHeader}>
          <Text style={styles.stepsHeading}>
            {t("tasks.workflow.stepsHeading", { count: state.steps.length })}
          </Text>
          <Button
            variant="ghost"
            size="sm"
            leftIcon={Plus}
            onPress={model.addStep}
            testID="task-workflow-form-add-step"
          >
            {t("tasks.workflow.addStep")}
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
