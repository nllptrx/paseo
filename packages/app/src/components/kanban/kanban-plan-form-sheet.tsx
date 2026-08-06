import { useCallback, useMemo, useSyncExternalStore, type ReactElement } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { Plus } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { KanbanPlanStepEditor } from "./kanban-plan-step-editor";
import { useKanbanMutations } from "@/hooks/use-kanban-mutations";
import { buildKanbanPlanCreateBody } from "@/kanban/kanban-plan-form-model";
import { useKanbanPlanFormModel } from "@/kanban/use-kanban-plan-form-model";
import { toErrorMessage } from "@/utils/error-messages";

export interface KanbanPlanFormSheetProps {
  serverId: string;
  kanbanId: string;
  parentPlanId: string | null;
  visible: boolean;
  onClose: () => void;
}

function openKey(props: KanbanPlanFormSheetProps): string {
  return `${props.serverId}:${props.kanbanId}:${props.parentPlanId ?? ""}`;
}

export function KanbanPlanFormSheet(props: KanbanPlanFormSheetProps): ReactElement | null {
  if (!props.visible) {
    return null;
  }
  return <OpenKanbanPlanFormSheet key={openKey(props)} {...props} />;
}

function OpenKanbanPlanFormSheet({
  serverId,
  kanbanId,
  parentPlanId,
  visible,
  onClose,
}: KanbanPlanFormSheetProps): ReactElement {
  const { t } = useTranslation();
  const { createPlan, isCreatingPlan } = useKanbanMutations({ serverId });
  const snapshot = useMemo(
    () => ({ serverId, kanbanId, parentPlanId }),
    [kanbanId, parentPlanId, serverId],
  );
  const model = useKanbanPlanFormModel(snapshot);
  const state = useSyncExternalStore(model.subscribe, model.getState, model.getState);
  const canSubmit = state.canSubmit && !isCreatingPlan;

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) {
      return;
    }
    const body = buildKanbanPlanCreateBody(state);
    if (!body) {
      return;
    }
    model.setSubmitError(null);
    try {
      await createPlan({
        kanbanId: state.kanbanId,
        parentPlanId: state.parentPlanId,
        title: state.title.trim(),
        description: state.description.trim().length > 0 ? state.description.trim() : null,
        body,
      });
      onClose();
    } catch (submitError) {
      model.setSubmitError(toErrorMessage(submitError));
    }
  }, [canSubmit, createPlan, model, onClose, state]);

  const handleSubmitPress = useCallback(() => {
    void handleSubmit();
  }, [handleSubmit]);

  const header = useMemo(() => ({ title: t("kanban.planForm.title") }), [t]);
  const footer = useMemo(
    () => (
      <Button
        variant="default"
        onPress={handleSubmitPress}
        disabled={!canSubmit}
        loading={isCreatingPlan}
        testID="kanban-plan-form-submit"
      >
        {t("kanban.planForm.submit")}
      </Button>
    ),
    [canSubmit, handleSubmitPress, isCreatingPlan, t],
  );

  return (
    <AdaptiveModalSheet
      header={header}
      visible={visible}
      onClose={onClose}
      testID="kanban-plan-form-sheet"
      footer={footer}
    >
      <View style={styles.form}>
        <Field label={t("kanban.planForm.titleLabel")} testID="kanban-plan-form-title">
          <FormTextInput
            value={state.title}
            onChangeText={model.setTitle}
            placeholder={t("kanban.planForm.titlePlaceholder")}
            testID="kanban-plan-form-title-input"
          />
        </Field>
        <Field label={t("kanban.planForm.descriptionLabel")} testID="kanban-plan-form-description">
          <FormTextInput
            value={state.description}
            onChangeText={model.setDescription}
            placeholder={t("kanban.planForm.descriptionPlaceholder")}
            multiline
            testID="kanban-plan-form-description-input"
          />
        </Field>
        <View style={styles.steps}>
          {state.steps.map((step, index) => (
            <KanbanPlanStepEditor
              key={step.key}
              step={step}
              index={index}
              stepCount={state.steps.length}
              state={state}
              model={model}
            />
          ))}
        </View>
        <Button
          variant="ghost"
          size="sm"
          leftIcon={Plus}
          onPress={model.addStep}
          testID="kanban-plan-form-add-step"
        >
          {t("kanban.planForm.addStep")}
        </Button>
        {state.submitError ? (
          <Text style={styles.error} testID="kanban-plan-form-error">
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
  error: {
    color: theme.colors.statusDanger,
    fontSize: theme.fontSize.sm,
  },
}));
