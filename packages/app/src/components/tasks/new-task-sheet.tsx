import {
  useCallback,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactElement,
} from "react";
import { Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronUp } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { TaskLabel, TaskProject, TaskStatus } from "@getpaseo/protocol/tasks/types";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { useNewTaskFormModel } from "@/tasks/use-new-task-form-model";
import { DEFAULT_TASK_PROJECT_COLOR } from "@/tasks/task-project-color";
import { useTaskMutations } from "@/tasks/use-tasks";
import { toErrorMessage } from "@/utils/error-messages";
import {
  TaskDueDateChip,
  TaskLabelsChip,
  TaskPriorityChip,
  TaskStatusChip,
} from "./task-property-chips";

const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronUp = withUnistyles(ChevronUp);
const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export interface NewTaskSheetProps {
  serverId: string;
  /** The tracker project the task lands in, or null when it must be created. */
  project: TaskProject | null;
  /** The project's labels, so capture can label before the card exists. */
  labels: readonly TaskLabel[];
  paseoProjectId: string | null;
  suggestedProjectName: string;
  initialStatus: TaskStatus;
  /** Prefills capture when an existing standalone agent becomes a task. */
  initialTitle?: string;
  /** Runs after either capture action creates the task. */
  onTaskCreated?: (taskId: string) => void;
  /** Called instead of closing empty-handed when the capture asked to plan the
   * work: the board opens the workflow editor on the task just made. */
  onCreated?: (taskId: string) => void;
  onClose: () => void;
}

function openKey(props: NewTaskSheetProps): string {
  return `${props.serverId}:${props.project?.id ?? ""}:${props.initialStatus}`;
}

/**
 * Capture costs one gesture and a title. Properties are optional chips, the
 * description an optional disclosure — nothing on this form asks a question
 * that could not be skipped. When the board's project does not have a tracker
 * project yet, the same sheet creates it with prefilled name and prefix rather
 * than sending you somewhere else first.
 */
export function NewTaskSheet(props: NewTaskSheetProps): ReactElement {
  return <OpenNewTaskSheet key={openKey(props)} {...props} />;
}

function OpenNewTaskSheet({
  serverId,
  project,
  labels,
  paseoProjectId,
  suggestedProjectName,
  initialStatus,
  initialTitle,
  onTaskCreated,
  onCreated,
  onClose,
}: NewTaskSheetProps): ReactElement {
  const { t } = useTranslation();
  const { createProject, createTask, createLabel, updateTask } = useTaskMutations(serverId);
  const snapshot = useMemo(
    () => ({
      serverId,
      project,
      paseoProjectId,
      suggestedProjectName,
      initialStatus,
      initialTitle,
    }),
    [initialStatus, initialTitle, paseoProjectId, project, serverId, suggestedProjectName],
  );
  const model = useNewTaskFormModel(snapshot);
  const state = useSyncExternalStore(model.subscribe, model.getState, model.getState);
  const [isDescriptionOpen, setIsDescriptionOpen] = useState(false);
  const toggleDescription = useCallback(() => setIsDescriptionOpen((current) => !current), []);
  const descriptionAccessibilityState = useMemo(
    () => ({ expanded: isDescriptionOpen }),
    [isDescriptionOpen],
  );
  /** Survives a failed property write, so retrying never creates a twin. */
  const createdTaskIdRef = useRef<string | null>(null);

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
        let taskId = createdTaskIdRef.current;
        if (!taskId) {
          const projectId =
            current.projectId ??
            (await createProject({
              name: current.projectName.trim(),
              prefix: current.prefix.trim().toUpperCase(),
              color: DEFAULT_TASK_PROJECT_COLOR,
              paseoProjectId: current.paseoProjectId,
            }));
          taskId = await createTask({
            projectId,
            title: current.title.trim(),
            status: current.status,
            ...(current.description.trim() ? { description: current.description.trim() } : {}),
          });
          createdTaskIdRef.current = taskId;
        }
        if (
          current.priority !== "none" ||
          current.dueDate !== null ||
          current.labelIds.length > 0
        ) {
          await updateTask({
            taskId,
            ...(current.priority !== "none" ? { priority: current.priority } : {}),
            ...(current.dueDate !== null ? { dueDate: current.dueDate } : {}),
            ...(current.labelIds.length > 0 ? { labelIds: [...current.labelIds] } : {}),
          });
        }
        onClose();
        onTaskCreated?.(taskId);
        if (thenAddWorkflow) {
          onCreated?.(taskId);
        }
      } catch (error) {
        model.setSubmitError(toErrorMessage(error));
      }
    },
    [createProject, createTask, model, onClose, onCreated, onTaskCreated, updateTask],
  );

  const handleCapturePress = useCallback(() => {
    void handleSubmit(false);
  }, [handleSubmit]);
  const handleCaptureAndPlanPress = useCallback(() => {
    void handleSubmit(true);
  }, [handleSubmit]);
  const handleSetLabelIds = useCallback(
    (labelIds: string[]) => model.setLabelIds(labelIds),
    [model],
  );

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
        <View style={styles.chipRow}>
          <TaskStatusChip
            status={state.status}
            onSelect={model.setStatus}
            testID="tasks-form-status-trigger"
          />
          <TaskPriorityChip
            priority={state.priority}
            onSelect={model.setPriority}
            testID="tasks-form-priority-trigger"
          />
          <TaskDueDateChip
            dueDate={state.dueDate}
            onSetDueDate={model.setDueDate}
            testID="tasks-form-due-trigger"
          />
          {project ? (
            <TaskLabelsChip
              projectId={project.id}
              projectLabels={labels}
              selectedLabelIds={state.labelIds}
              supportsDeletion={false}
              onSetLabelIds={handleSetLabelIds}
              onCreateLabel={createLabel}
              testID="tasks-form-labels-trigger"
            />
          ) : null}
        </View>
        <Pressable
          onPress={toggleDescription}
          accessibilityRole="button"
          accessibilityState={descriptionAccessibilityState}
          style={styles.descriptionToggle}
          testID="tasks-form-description-toggle"
        >
          <Text style={styles.descriptionToggleLabel}>Description (optional)</Text>
          {isDescriptionOpen ? (
            <ThemedChevronUp size={ICON_SIZE.sm} uniProps={mutedIconMapping} />
          ) : (
            <ThemedChevronDown size={ICON_SIZE.sm} uniProps={mutedIconMapping} />
          )}
        </Pressable>
        {isDescriptionOpen ? (
          <FormTextInput
            value={state.description}
            onChangeText={model.setDescription}
            placeholder="Describe the outcome, context, and constraints for the agent"
            multiline
            testID="tasks-form-description-input"
          />
        ) : null}
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
  chipRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[1.5],
  },
  descriptionToggle: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    borderWidth: theme.borderWidth[1],
    borderStyle: "dashed",
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    paddingHorizontal: theme.spacing[3],
  },
  descriptionToggleLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
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
