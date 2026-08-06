import { useCallback, useMemo, useSyncExternalStore, type ReactElement } from "react";
import { View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { SelectField } from "@/components/ui/select-field";
import { useKanbanMutations } from "@/hooks/use-kanban-mutations";
import { buildKanbanPlanCreateBody } from "@/kanban/kanban-plan-form-model";
import { useKanbanPlanFormModel } from "@/kanban/use-kanban-plan-form-model";
import { toErrorMessage } from "@/utils/error-messages";

export interface KanbanPlanFormSheetProps {
  serverId: string;
  kanbanId: string;
  parentPlanId: string | null;
  columnId: string;
  visible: boolean;
  onClose: () => void;
}

function openKey(props: KanbanPlanFormSheetProps): string {
  return `${props.serverId}:${props.kanbanId}:${props.parentPlanId ?? ""}:${props.columnId}`;
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
  columnId,
  visible,
  onClose,
}: KanbanPlanFormSheetProps): ReactElement {
  const { t } = useTranslation();
  const { createPlan, isCreatingPlan } = useKanbanMutations({ serverId });
  const snapshot = useMemo(
    () => ({ serverId, kanbanId, parentPlanId, columnId }),
    [columnId, kanbanId, parentPlanId, serverId],
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
        columnId: state.columnId,
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
        <Field
          label={t("kanban.planForm.promptLabel")}
          hint={t("kanban.planForm.promptHint")}
          error={state.submitError}
          testID="kanban-plan-form-prompt"
        >
          <FormTextInput
            value={state.prompt}
            onChangeText={model.setPrompt}
            placeholder={t("kanban.planForm.promptPlaceholder")}
            multiline
            testID="kanban-plan-form-prompt-input"
          />
        </Field>
        <SelectField
          label={t("kanban.planForm.providerLabel")}
          value={state.selectedProvider}
          selectedDisplay={state.selectedProviderDisplay}
          options={state.providerOptions}
          onChange={model.setProvider}
          placeholder={t("kanban.planForm.providerPlaceholder")}
          emptyText={t("kanban.planForm.providerEmptyText")}
          loading={state.providerResolutionStatus === "pending"}
          testID="kanban-plan-form-provider"
          triggerTestID="kanban-plan-form-provider-trigger"
        />
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
