import { useCallback, useMemo, useState, useSyncExternalStore, type ReactElement } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { Task } from "@getpaseo/protocol/tasks/types";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/form-field";
import type { FieldControlSize } from "@/components/ui/control-geometry";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useTaskDueDateForm } from "@/tasks/use-task-due-date-form";
import { toErrorMessage } from "@/utils/error-messages";
import { TaskDueDateInput } from "./task-due-date-input";

export interface TaskDueDateFormSheetProps {
  currentDueDate: string | null;
  onSubmit: (dueDate: string) => Promise<Task>;
  onClose: () => void;
}

export function TaskDueDateFormSheet({
  currentDueDate,
  onSubmit,
  onClose,
}: TaskDueDateFormSheetProps): ReactElement {
  const form = useTaskDueDateForm(currentDueDate);
  const state = useSyncExternalStore(form.subscribe, form.getState, form.getState);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const controlSize: FieldControlSize = useIsCompactFormFactor() ? "md" : "sm";

  const handleClose = useCallback(() => {
    if (!isSubmitting) onClose();
  }, [isSubmitting, onClose]);
  const handleSubmit = useCallback(() => {
    if (!state.canSubmit || isSubmitting) return;
    setIsSubmitting(true);
    form.setSubmitError(null);
    void onSubmit(state.dueDate)
      .then(onClose)
      .catch((error) => form.setSubmitError(toErrorMessage(error)))
      .finally(() => setIsSubmitting(false));
  }, [form, isSubmitting, onClose, onSubmit, state.canSubmit, state.dueDate]);

  const header = useMemo<SheetHeader>(() => ({ title: "Custom due date" }), []);
  const footer = useMemo(
    () => (
      <View style={styles.footer}>
        <Button style={styles.footerButton} onPress={handleClose} disabled={isSubmitting}>
          Cancel
        </Button>
        <Button
          variant="default"
          style={styles.footerButton}
          onPress={handleSubmit}
          disabled={!state.canSubmit}
          loading={isSubmitting}
          testID="task-due-date-custom-save"
        >
          Save
        </Button>
      </View>
    ),
    [handleClose, handleSubmit, isSubmitting, state.canSubmit],
  );

  return (
    <AdaptiveModalSheet
      header={header}
      visible
      onClose={handleClose}
      footer={footer}
      desktopMaxWidth={400}
      presentation="push"
      testID="task-due-date-custom-sheet"
    >
      <Field label="Due date" error={state.validationError ?? state.submitError}>
        <TaskDueDateInput
          value={state.dueDate}
          onChange={form.setDueDate}
          disabled={isSubmitting}
          size={controlSize}
        />
      </Field>
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  footer: {
    flex: 1,
    flexDirection: "row",
    gap: theme.spacing[2],
  },
  footerButton: {
    flex: 1,
  },
}));
