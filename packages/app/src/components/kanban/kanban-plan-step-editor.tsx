import { useCallback, useMemo, type ReactElement } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronUp, Trash2 } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { AgentProvider } from "@getpaseo/protocol/agent-types";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { SelectField } from "@/components/ui/select-field";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import {
  KANBAN_PLAN_TRIGGER_TYPES,
  KANBAN_PLAN_WORKSPACE_MODES,
  resolveProviderDisplay,
  type KanbanPlanFormModel,
  type KanbanPlanFormState,
  type KanbanPlanFormStep,
  type KanbanPlanFormTriggerType,
  type KanbanPlanFormWorkspaceMode,
} from "@/kanban/kanban-plan-form-model";

const ThemedTrash = withUnistyles(Trash2);
const ThemedChevronUp = withUnistyles(ChevronUp);
const ThemedChevronDown = withUnistyles(ChevronDown);
const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

const WORKSPACE_MODE_LABEL_KEYS: Record<KanbanPlanFormWorkspaceMode, string> = {
  worktree: "kanban.planForm.workspace.worktree",
  worktree_per_agent: "kanban.planForm.workspace.worktreePerAgent",
  reuse_previous: "kanban.planForm.workspace.reusePrevious",
  existing: "kanban.planForm.workspace.existing",
};

const TRIGGER_LABEL_KEYS: Record<KanbanPlanFormTriggerType, string> = {
  manual: "kanban.planForm.trigger.manual",
  immediate: "kanban.planForm.trigger.immediate",
  schedule: "kanban.planForm.trigger.schedule",
};

export interface KanbanPlanStepEditorProps {
  step: KanbanPlanFormStep;
  index: number;
  stepCount: number;
  state: KanbanPlanFormState;
  model: KanbanPlanFormModel;
}

/**
 * One step of a workflow: what to run, which agent runs it, where, and what
 * starts it. Everything a step carries on the wire is editable here — a form that
 * only asked for a prompt could only ever author the simplest possible plan.
 */
export function KanbanPlanStepEditor({
  step,
  index,
  stepCount,
  state,
  model,
}: KanbanPlanStepEditorProps): ReactElement {
  const { t } = useTranslation();
  const { key } = step;

  const handleName = useCallback((value: string) => model.setStepName(key, value), [key, model]);
  const handlePrompt = useCallback(
    (value: string) => model.setStepPrompt(key, value),
    [key, model],
  );
  const handleProvider = useCallback(
    (provider: AgentProvider) => model.setStepAgent(key, { provider, model: null }),
    [key, model],
  );
  const handleWorkspace = useCallback(
    (mode: KanbanPlanFormWorkspaceMode) => model.setStepWorkspaceMode(key, mode),
    [key, model],
  );
  const handleTrigger = useCallback(
    (trigger: KanbanPlanFormTriggerType) => model.setStepTrigger(key, trigger),
    [key, model],
  );
  const handleRemove = useCallback(() => model.removeStep(key), [key, model]);
  const handleMoveUp = useCallback(() => model.moveStep(key, -1), [key, model]);
  const handleMoveDown = useCallback(() => model.moveStep(key, 1), [key, model]);

  const workspaceOptions = useMemo(
    () =>
      KANBAN_PLAN_WORKSPACE_MODES.map((mode) => ({
        id: mode,
        value: mode,
        label: t(WORKSPACE_MODE_LABEL_KEYS[mode]),
        testID: `kanban-plan-form-workspace-option-${mode}`,
      })),
    [t],
  );
  const workspaceDisplay = useMemo(
    () => ({ label: t(WORKSPACE_MODE_LABEL_KEYS[step.workspaceMode]) }),
    [step.workspaceMode, t],
  );
  const triggerDisplay = useMemo(
    () => ({ label: t(TRIGGER_LABEL_KEYS[step.trigger]) }),
    [step.trigger, t],
  );
  const triggerOptions = useMemo(
    () =>
      KANBAN_PLAN_TRIGGER_TYPES.map((trigger) => ({
        id: trigger,
        value: trigger,
        label: t(TRIGGER_LABEL_KEYS[trigger]),
        testID: `kanban-plan-form-trigger-option-${trigger}`,
      })),
    [t],
  );

  return (
    <View style={styles.step} testID={`kanban-plan-form-step-${index}`}>
      <View style={styles.header}>
        <Text style={styles.heading}>
          {t("kanban.planForm.stepHeading", { index: index + 1, total: stepCount })}
        </Text>
        <View style={styles.headerActions}>
          <Button
            variant="ghost"
            size="xs"
            onPress={handleMoveUp}
            disabled={index === 0}
            accessibilityLabel={t("kanban.planForm.moveStepUp")}
            testID={`kanban-plan-form-step-up-${index}`}
          >
            <ThemedChevronUp size={ICON_SIZE.sm} uniProps={mutedIconMapping} />
          </Button>
          <Button
            variant="ghost"
            size="xs"
            onPress={handleMoveDown}
            disabled={index === stepCount - 1}
            accessibilityLabel={t("kanban.planForm.moveStepDown")}
            testID={`kanban-plan-form-step-down-${index}`}
          >
            <ThemedChevronDown size={ICON_SIZE.sm} uniProps={mutedIconMapping} />
          </Button>
          <Button
            variant="ghost"
            size="xs"
            onPress={handleRemove}
            disabled={stepCount <= 1}
            accessibilityLabel={t("kanban.planForm.removeStep")}
            testID={`kanban-plan-form-step-remove-${index}`}
          >
            <ThemedTrash size={ICON_SIZE.sm} uniProps={mutedIconMapping} />
          </Button>
        </View>
      </View>

      <Field
        label={t("kanban.planForm.stepNameLabel")}
        testID={`kanban-plan-form-step-name-${index}`}
      >
        <FormTextInput
          value={step.name}
          onChangeText={handleName}
          placeholder={t("kanban.planForm.stepNamePlaceholder")}
          testID={`kanban-plan-form-step-name-input-${index}`}
        />
      </Field>

      <Field
        label={t("kanban.planForm.promptLabel")}
        hint={t("kanban.planForm.promptHint")}
        testID={`kanban-plan-form-step-prompt-${index}`}
      >
        <FormTextInput
          value={step.prompt}
          onChangeText={handlePrompt}
          placeholder={t("kanban.planForm.promptPlaceholder")}
          multiline
          testID={`kanban-plan-form-step-prompt-input-${index}`}
        />
      </Field>

      <SelectField
        label={t("kanban.planForm.providerLabel")}
        value={step.provider}
        selectedDisplay={resolveProviderDisplay(state.providerOptions, step.provider)}
        options={state.providerOptions}
        onChange={handleProvider}
        placeholder={t("kanban.planForm.providerPlaceholder")}
        emptyText={t("kanban.planForm.providerEmptyText")}
        loading={state.providerResolutionStatus === "pending"}
        testID={`kanban-plan-form-provider-${index}`}
        triggerTestID={`kanban-plan-form-provider-trigger-${index}`}
      />

      <View style={styles.row}>
        <View style={styles.rowItem}>
          <SelectField
            label={t("kanban.planForm.workspaceLabel")}
            value={step.workspaceMode}
            selectedDisplay={workspaceDisplay}
            options={workspaceOptions}
            onChange={handleWorkspace}
            placeholder={t("kanban.planForm.workspaceLabel")}
            emptyText={t("kanban.planForm.workspaceLabel")}
            testID={`kanban-plan-form-workspace-${index}`}
            triggerTestID={`kanban-plan-form-workspace-trigger-${index}`}
          />
        </View>
        <View style={styles.rowItem}>
          <SelectField
            label={t("kanban.planForm.triggerLabel")}
            hint={index === 0 ? undefined : t("kanban.planForm.triggerHint")}
            value={step.trigger}
            selectedDisplay={triggerDisplay}
            options={triggerOptions}
            onChange={handleTrigger}
            placeholder={t("kanban.planForm.triggerLabel")}
            emptyText={t("kanban.planForm.triggerLabel")}
            testID={`kanban-plan-form-trigger-${index}`}
            triggerTestID={`kanban-plan-form-trigger-trigger-${index}`}
          />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  step: {
    gap: theme.spacing[3],
    padding: theme.spacing[3],
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface1,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  heading: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  headerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  row: {
    flexDirection: "row",
    gap: theme.spacing[3],
  },
  rowItem: {
    flex: 1,
    minWidth: 0,
  },
}));
