import { useCallback, useMemo, useSyncExternalStore, type ReactElement } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { TaskProject, TaskStatus } from "@getpaseo/protocol/tasks/types";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { useNewTaskFormModel } from "@/tasks/use-new-task-form-model";
import { useTaskMutations } from "@/tasks/use-tasks";
import { toErrorMessage } from "@/utils/error-messages";

const DEFAULT_PROJECT_COLOR = "#7C6BF5";

export interface NewTaskSheetProps {
  serverId: string;
  /** The tracker project the task lands in, or null when it must be created. */
  project: TaskProject | null;
  paseoProjectId: string | null;
  suggestedProjectName: string;
  initialStatus: TaskStatus;
  /** Called instead of closing empty-handed when the capture asked to plan the
   * work: the board opens the workflow editor on the task just made. */
  onCreated?: (taskId: string) => void;
  onClose: () => void;
}

function openKey(props: NewTaskSheetProps): string {
  return `${props.serverId}:${props.project?.id ?? ""}:${props.initialStatus}`;
}

/**
 * Capture costs one gesture and a title. When the board's project does not have
 * a tracker project yet, the same sheet creates it with prefilled name and
 * prefix rather than sending you somewhere else first — a capture form that
 * asks questions is a capture form that gets skipped.
 */
export function NewTaskSheet(props: NewTaskSheetProps): ReactElement {
  return <OpenNewTaskSheet key={openKey(props)} {...props} />;
}

function OpenNewTaskSheet({
  serverId,
  project,
  paseoProjectId,
  suggestedProjectName,
  initialStatus,
  onCreated,
  onClose,
}: NewTaskSheetProps): ReactElement {
  const { t } = useTranslation();
  const { createProject, createTask } = useTaskMutations(serverId);
  const snapshot = useMemo(
    () => ({ serverId, project, paseoProjectId, suggestedProjectName, initialStatus }),
    [initialStatus, paseoProjectId, project, serverId, suggestedProjectName],
  );
  const model = useNewTaskFormModel(snapshot);
  const state = useSyncExternalStore(model.subscribe, model.getState, model.getState);

  const handleSubmit = useCallback(
    async (thenAddWorkflow: boolean) => {
      const current = model.getState();
      if (!current.canSubmit) {
        return;
      }
      model.setSubmitting(true);
      try {
        // The id comes back from the create rather than from the snapshot: the
        // snapshot has not refetched yet, so reading it here would find nothing
        // and silently drop the task.
        const projectId =
          current.projectId ??
          (await createProject({
            name: current.projectName.trim(),
            prefix: current.prefix.trim().toUpperCase(),
            color: DEFAULT_PROJECT_COLOR,
            paseoProjectId: current.paseoProjectId,
          }));
        const taskId = await createTask({
          projectId,
          title: current.title.trim(),
          status: current.initialStatus,
        });
        onClose();
        if (thenAddWorkflow) {
          onCreated?.(taskId);
        }
      } catch (error) {
        model.setSubmitError(toErrorMessage(error));
      }
    },
    [createProject, createTask, model, onClose, onCreated],
  );

  const handleCapturePress = useCallback(() => {
    void handleSubmit(false);
  }, [handleSubmit]);
  const handleCaptureAndPlanPress = useCallback(() => {
    void handleSubmit(true);
  }, [handleSubmit]);

  const header = useMemo(() => ({ title: t("tasks.form.title") }), [t]);
  // Two buttons rather than a wizard step: the choice to plan the work now is
  // made once, where the task is named, and neither path is a dead end.
  const footer = useMemo(
    () => (
      <View style={styles.footer}>
        <Button
          variant="ghost"
          onPress={handleCapturePress}
          disabled={!state.canSubmit}
          loading={state.isSubmitting}
          testID="tasks-form-submit"
        >
          {t("tasks.form.submit")}
        </Button>
        <Button
          variant="default"
          onPress={handleCaptureAndPlanPress}
          disabled={!state.canSubmit}
          loading={state.isSubmitting}
          testID="tasks-form-submit-with-workflow"
        >
          {t("tasks.form.submitWithWorkflow")}
        </Button>
      </View>
    ),
    [handleCaptureAndPlanPress, handleCapturePress, state.canSubmit, state.isSubmitting, t],
  );

  return (
    <AdaptiveModalSheet
      header={header}
      visible
      onClose={onClose}
      footer={footer}
      testID="tasks-form-sheet"
    >
      <View style={styles.form}>
        <Field label={t("tasks.form.taskTitleLabel")} testID="tasks-form-title">
          <FormTextInput
            value={state.title}
            onChangeText={model.setTitle}
            placeholder={t("tasks.form.taskTitlePlaceholder")}
            autoFocus
            testID="tasks-form-title-input"
          />
        </Field>
        {state.needsProject ? (
          <>
            <Text style={styles.formHint}>{t("tasks.form.firstProjectHint")}</Text>
            <Field label={t("tasks.form.projectNameLabel")} testID="tasks-form-project-name">
              <FormTextInput
                value={state.projectName}
                onChangeText={model.setProjectName}
                placeholder={t("tasks.form.projectNamePlaceholder")}
                testID="tasks-form-project-name-input"
              />
            </Field>
            <Field
              label={t("tasks.form.prefixLabel")}
              hint={t("tasks.form.prefixHint")}
              testID="tasks-form-prefix"
            >
              <FormTextInput
                value={state.prefix}
                onChangeText={model.setPrefix}
                placeholder={t("tasks.form.prefixPlaceholder")}
                testID="tasks-form-prefix-input"
              />
            </Field>
          </>
        ) : null}
        {state.submitError ? <Text style={styles.errorText}>{state.submitError}</Text> : null}
      </View>
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  footer: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
  },
  form: {
    gap: theme.spacing[4],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
  },
  formHint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  errorText: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
}));
