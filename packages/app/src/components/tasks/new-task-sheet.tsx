import { useCallback, useMemo, useState, type ReactElement } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { TaskProject, TaskStatus } from "@getpaseo/protocol/tasks/types";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { useTaskMutations } from "@/tasks/use-tasks";
import { toErrorMessage } from "@/utils/error-messages";

const DEFAULT_PROJECT_COLOR = "#7C6BF5";
const PREFIX_MAX_LENGTH = 8;

/** `Paseo Mobile` → `PAS`: enough to read as a key, always editable before submit. */
export function suggestTaskProjectPrefix(name: string): string {
  const letters = name.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
  return letters.slice(0, Math.min(3, PREFIX_MAX_LENGTH));
}

/**
 * Capture costs one gesture and a title. When the board's project does not have
 * a tracker project yet, the same sheet creates it with prefilled name and
 * prefix rather than sending you somewhere else first — a capture form that
 * asks questions is a capture form that gets skipped.
 */
export function NewTaskSheet({
  serverId,
  project,
  paseoProjectId,
  suggestedProjectName,
  initialStatus,
  onClose,
}: {
  serverId: string;
  /** The tracker project the task lands in, or null when it must be created. */
  project: TaskProject | null;
  paseoProjectId: string | null;
  suggestedProjectName: string;
  initialStatus: TaskStatus;
  onClose: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const { createProject, createTask, isBusy } = useTaskMutations(serverId);
  const [title, setTitle] = useState("");
  const [projectName, setProjectName] = useState(suggestedProjectName);
  const [prefix, setPrefix] = useState(() => suggestTaskProjectPrefix(suggestedProjectName));
  const [submitError, setSubmitError] = useState<string | null>(null);

  const needsProject = project === null;
  const canSubmit =
    title.trim().length > 0 &&
    (!needsProject || (projectName.trim().length > 0 && prefix.trim().length > 0)) &&
    !isBusy;

  const handleSubmit = useCallback(() => {
    setSubmitError(null);
    void (async () => {
      try {
        // The id comes back from the create rather than from the snapshot: the
        // snapshot has not refetched yet, so reading it here would find nothing
        // and silently drop the task.
        const projectId = needsProject
          ? await createProject({
              name: projectName.trim(),
              prefix: prefix.trim().toUpperCase(),
              color: DEFAULT_PROJECT_COLOR,
              paseoProjectId,
            })
          : project.id;
        await createTask({ projectId, title: title.trim(), status: initialStatus });
        onClose();
      } catch (error) {
        setSubmitError(toErrorMessage(error));
      }
    })();
  }, [
    createProject,
    createTask,
    initialStatus,
    needsProject,
    onClose,
    paseoProjectId,
    prefix,
    project,
    projectName,
    title,
  ]);

  const header = useMemo(() => ({ title: t("tasks.form.title") }), [t]);
  const footer = useMemo(
    () => (
      <Button
        variant="default"
        onPress={handleSubmit}
        disabled={!canSubmit}
        loading={isBusy}
        testID="tasks-form-submit"
      >
        {t("tasks.form.submit")}
      </Button>
    ),
    [canSubmit, handleSubmit, isBusy, t],
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
            value={title}
            onChangeText={setTitle}
            placeholder={t("tasks.form.taskTitlePlaceholder")}
            autoFocus
            testID="tasks-form-title-input"
          />
        </Field>
        {needsProject ? (
          <>
            <Text style={styles.formHint}>{t("tasks.form.firstProjectHint")}</Text>
            <Field label={t("tasks.form.projectNameLabel")} testID="tasks-form-project-name">
              <FormTextInput
                value={projectName}
                onChangeText={setProjectName}
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
                value={prefix}
                onChangeText={setPrefix}
                placeholder={t("tasks.form.prefixPlaceholder")}
                testID="tasks-form-prefix-input"
              />
            </Field>
          </>
        ) : null}
        {submitError ? <Text style={styles.errorText}>{submitError}</Text> : null}
      </View>
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
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
