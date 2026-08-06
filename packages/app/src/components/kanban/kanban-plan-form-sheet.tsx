import { useCallback, useMemo, useState, type ReactElement } from "react";
import { View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { KanbanPlanCreateBody } from "@getpaseo/protocol/kanban/rpc-schemas";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { useKanbanMutations } from "@/hooks/use-kanban-mutations";
import { toErrorMessage } from "@/utils/error-messages";

export interface KanbanPlanFormSheetProps {
  serverId: string;
  kanbanId: string;
  parentPlanId: string | null;
  columnId: string;
  visible: boolean;
  onClose: () => void;
}

// Minimum-viable plan editor: title, description, and a single manual-trigger
// step. Multi-step editing and provider/model selection are follow-up work
// once this surface has a full non-React form-model, per docs/forms.md.
export function KanbanPlanFormSheet({
  serverId,
  kanbanId,
  parentPlanId,
  columnId,
  visible,
  onClose,
}: KanbanPlanFormSheetProps): ReactElement {
  const { t } = useTranslation();
  const { createPlan } = useKanbanMutations({ serverId });
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [prompt, setPrompt] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = useCallback(() => {
    setTitle("");
    setDescription("");
    setPrompt("");
    setError(null);
  }, []);

  const handleClose = useCallback(() => {
    reset();
    onClose();
  }, [onClose, reset]);

  const canSubmit = title.trim().length > 0 && prompt.trim().length > 0 && !isSubmitting;

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) {
      return;
    }
    setIsSubmitting(true);
    setError(null);
    const body: KanbanPlanCreateBody = {
      type: "workflow",
      steps: [
        {
          name: title.trim(),
          prompt: prompt.trim(),
          agents: [{ provider: "claude" }],
          completion: "all",
          workspace: { mode: "worktree" },
          trigger: { type: "manual" },
        },
      ],
    };
    try {
      await createPlan({
        kanbanId,
        parentPlanId,
        columnId,
        title: title.trim(),
        description: description.trim().length > 0 ? description.trim() : null,
        body,
      });
      handleClose();
    } catch (submitError) {
      setError(toErrorMessage(submitError));
    } finally {
      setIsSubmitting(false);
    }
  }, [
    canSubmit,
    columnId,
    createPlan,
    description,
    handleClose,
    kanbanId,
    parentPlanId,
    prompt,
    title,
  ]);

  const header = useMemo(() => ({ title: t("kanban.planForm.title") }), [t]);
  const footer = useMemo(
    () => (
      <Button
        variant="default"
        onPress={handleSubmit}
        disabled={!canSubmit}
        loading={isSubmitting}
        testID="kanban-plan-form-submit"
      >
        {t("kanban.planForm.submit")}
      </Button>
    ),
    [canSubmit, handleSubmit, isSubmitting, t],
  );

  return (
    <AdaptiveModalSheet
      header={header}
      visible={visible}
      onClose={handleClose}
      testID="kanban-plan-form-sheet"
      footer={footer}
    >
      <View style={styles.form}>
        <Field label={t("kanban.planForm.titleLabel")} testID="kanban-plan-form-title">
          <FormTextInput
            value={title}
            onChangeText={setTitle}
            placeholder={t("kanban.planForm.titlePlaceholder")}
            testID="kanban-plan-form-title-input"
          />
        </Field>
        <Field label={t("kanban.planForm.descriptionLabel")} testID="kanban-plan-form-description">
          <FormTextInput
            value={description}
            onChangeText={setDescription}
            placeholder={t("kanban.planForm.descriptionPlaceholder")}
            multiline
            testID="kanban-plan-form-description-input"
          />
        </Field>
        <Field
          label={t("kanban.planForm.promptLabel")}
          hint={t("kanban.planForm.promptHint")}
          error={error}
          testID="kanban-plan-form-prompt"
        >
          <FormTextInput
            value={prompt}
            onChangeText={setPrompt}
            placeholder={t("kanban.planForm.promptPlaceholder")}
            multiline
            testID="kanban-plan-form-prompt-input"
          />
        </Field>
      </View>
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  form: {
    gap: theme.spacing[4],
    paddingHorizontal: theme.spacing[4],
    paddingTop: theme.spacing[2],
  },
}));
