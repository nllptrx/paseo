import { useCallback, useMemo, useState, type ReactElement } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronUp, Settings2, Trash2 } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { AgentProvider } from "@getpaseo/protocol/agent-types";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { AgentModelField } from "@/components/agents/agent-model-field";
import { SelectField } from "@/components/ui/select-field";
import { Switch } from "@/components/ui/switch";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import {
  TASK_WORKFLOW_TRIGGER_LABEL_KEYS,
  TASK_WORKFLOW_TRIGGER_TYPES,
  TASK_WORKFLOW_WORKSPACE_LABEL_KEYS,
  TASK_WORKFLOW_WORKSPACE_MODES,
  type TaskWorkflowFormModel,
  type TaskWorkflowFormState,
  type TaskWorkflowFormStep,
  type TaskWorkflowFormTriggerType,
  type TaskWorkflowFormWorkspaceMode,
} from "@/tasks/task-workflow-form-model";

const ThemedTrash = withUnistyles(Trash2);
const ThemedChevronUp = withUnistyles(ChevronUp);
const ThemedChevronDown = withUnistyles(ChevronDown);
const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export interface TaskWorkflowStepEditorProps {
  step: TaskWorkflowFormStep;
  index: number;
  stepCount: number;
  state: TaskWorkflowFormState;
  model: TaskWorkflowFormModel;
}

/**
 * One step of a workflow: what to run, which agent runs it, where, and what
 * starts it. Everything a step carries on the wire is editable here — a form that
 * only asked for a prompt could only ever author the simplest possible workflow.
 */
export function TaskWorkflowStepEditor({
  step,
  index,
  stepCount,
  state,
  model,
}: TaskWorkflowStepEditorProps): ReactElement {
  const { t } = useTranslation();
  const { key } = step;
  const [advanced, setAdvanced] = useState(
    Boolean(
      step.source &&
      (step.workspaceMode !== "worktree" ||
        step.trigger !== "manual" ||
        step.requireChanges === false ||
        step.verifyCommand ||
        step.timeoutMinutes),
    ),
  );

  const handleName = useCallback((value: string) => model.setStepName(key, value), [key, model]);
  const handlePrompt = useCallback(
    (value: string) => model.setStepPrompt(key, value),
    [key, model],
  );
  const handleAgent = useCallback(
    (selection: { provider: AgentProvider; model: string | null }) =>
      model.setStepAgent(key, selection),
    [key, model],
  );
  const handleWorkspace = useCallback(
    (mode: TaskWorkflowFormWorkspaceMode) => model.setStepWorkspaceMode(key, mode),
    [key, model],
  );
  const handleTrigger = useCallback(
    (trigger: TaskWorkflowFormTriggerType) => model.setStepTrigger(key, trigger),
    [key, model],
  );
  const handleRemove = useCallback(() => model.removeStep(key), [key, model]);
  const handleMoveUp = useCallback(() => model.moveStep(key, -1), [key, model]);
  const handleMoveDown = useCallback(() => model.moveStep(key, 1), [key, model]);
  const toggleAdvanced = useCallback(() => setAdvanced((value) => !value), []);

  // The first step has nothing before it, so the two choices that name a
  // previous step are not offered there. A mode the form cannot author but the
  // step already uses stays listed, or opening the editor would read as if the
  // author had chosen something else.
  const workspaceOptions = useMemo(() => {
    const offered = TASK_WORKFLOW_WORKSPACE_MODES.filter(
      (mode) => index > 0 || mode !== "reuse_previous",
    );
    const modes = offered.includes(step.workspaceMode) ? offered : [...offered, step.workspaceMode];
    return modes.map((mode) => ({
      id: mode,
      value: mode,
      label: t(TASK_WORKFLOW_WORKSPACE_LABEL_KEYS[mode]),
      testID: `task-workflow-form-workspace-option-${mode}`,
    }));
  }, [index, step.workspaceMode, t]);
  const workspaceDisplay = useMemo(
    () => ({ label: t(TASK_WORKFLOW_WORKSPACE_LABEL_KEYS[step.workspaceMode]) }),
    [step.workspaceMode, t],
  );
  const handleRequireChanges = useCallback(
    (value: boolean) => model.setStepRequireChanges(key, value),
    [key, model],
  );
  const handleVerifyCommand = useCallback(
    (value: string) => model.setStepVerifyCommand(key, value),
    [key, model],
  );
  const handleTimeoutMinutes = useCallback(
    (value: string) => model.setStepTimeoutMinutes(key, value),
    [key, model],
  );

  const triggerDisplay = useMemo(
    () => ({ label: t(TASK_WORKFLOW_TRIGGER_LABEL_KEYS[step.trigger]) }),
    [step.trigger, t],
  );
  // "Immediately" means "when the step before this one finishes", which the
  // first step cannot wait for.
  const triggerOptions = useMemo(() => {
    const offered = TASK_WORKFLOW_TRIGGER_TYPES.filter(
      (trigger) => index > 0 || trigger !== "immediate",
    );
    const triggers = offered.includes(step.trigger) ? offered : [...offered, step.trigger];
    return triggers.map((trigger) => ({
      id: trigger,
      value: trigger,
      label: t(TASK_WORKFLOW_TRIGGER_LABEL_KEYS[trigger]),
      testID: `task-workflow-form-trigger-option-${trigger}`,
    }));
  }, [index, step.trigger, t]);

  return (
    <View style={styles.step} testID={`task-workflow-form-step-${index}`}>
      <View style={styles.header}>
        <Text style={styles.heading}>
          {t("tasks.workflow.stepHeading", { index: index + 1, total: stepCount })}
        </Text>
        <View style={styles.headerActions}>
          <Button
            variant="ghost"
            size="xs"
            onPress={handleMoveUp}
            disabled={index === 0}
            accessibilityLabel={t("tasks.workflow.moveStepUp")}
            testID={`task-workflow-form-step-up-${index}`}
          >
            <ThemedChevronUp size={ICON_SIZE.sm} uniProps={mutedIconMapping} />
          </Button>
          <Button
            variant="ghost"
            size="xs"
            onPress={handleMoveDown}
            disabled={index === stepCount - 1}
            accessibilityLabel={t("tasks.workflow.moveStepDown")}
            testID={`task-workflow-form-step-down-${index}`}
          >
            <ThemedChevronDown size={ICON_SIZE.sm} uniProps={mutedIconMapping} />
          </Button>
          <Button
            variant="ghost"
            size="xs"
            onPress={handleRemove}
            disabled={stepCount <= 1}
            accessibilityLabel={t("tasks.workflow.removeStep")}
            testID={`task-workflow-form-step-remove-${index}`}
          >
            <ThemedTrash size={ICON_SIZE.sm} uniProps={mutedIconMapping} />
          </Button>
        </View>
      </View>

      <Field label="Action" testID={`task-workflow-form-step-name-${index}`}>
        <FormTextInput
          value={step.name}
          onChangeText={handleName}
          placeholder="Implement, investigate, review…"
          testID={`task-workflow-form-step-name-input-${index}`}
        />
      </Field>

      <Field
        label="Agent brief"
        hint="The task title and description are included automatically. Add only what this action needs."
        testID={`task-workflow-form-step-prompt-${index}`}
      >
        <FormTextInput
          value={step.prompt}
          onChangeText={handlePrompt}
          placeholder="What should the agent do in this action?"
          multiline
          testID={`task-workflow-form-step-prompt-input-${index}`}
        />
      </Field>

      <AgentModelField
        serverId={state.serverId}
        label={t("tasks.workflow.agentLabel")}
        provider={step.provider}
        model={step.model}
        onSelect={handleAgent}
        placeholder={t("tasks.workflow.providerPlaceholder")}
        testID={`task-workflow-form-agent-${index}`}
      />
      <View style={styles.executionSummary}>
        <Text style={styles.executionSummaryText}>
          {workspaceDisplay.label} · {triggerDisplay.label}
        </Text>
        <Button
          variant="ghost"
          size="xs"
          leftIcon={Settings2}
          onPress={toggleAdvanced}
          testID={`task-workflow-form-step-advanced-${index}`}
        >
          {advanced ? "Hide settings" : "Advanced"}
        </Button>
      </View>

      {advanced ? (
        <View style={styles.advanced} testID={`task-workflow-form-step-advanced-fields-${index}`}>
          <View style={styles.row}>
            <View style={styles.rowItem}>
              <SelectField
                label={t("tasks.workflow.workspaceLabel")}
                value={step.workspaceMode}
                selectedDisplay={workspaceDisplay}
                options={workspaceOptions}
                onChange={handleWorkspace}
                placeholder={t("tasks.workflow.workspaceLabel")}
                emptyText={t("tasks.workflow.workspaceLabel")}
                testID={`task-workflow-form-workspace-${index}`}
                triggerTestID={`task-workflow-form-workspace-trigger-${index}`}
              />
            </View>
            <View style={styles.rowItem}>
              <SelectField
                label={t("tasks.workflow.triggerLabel")}
                hint={index === 0 ? undefined : t("tasks.workflow.triggerHint")}
                value={step.trigger}
                selectedDisplay={triggerDisplay}
                options={triggerOptions}
                onChange={handleTrigger}
                placeholder={t("tasks.workflow.triggerLabel")}
                emptyText={t("tasks.workflow.triggerLabel")}
                testID={`task-workflow-form-trigger-${index}`}
                triggerTestID={`task-workflow-form-trigger-trigger-${index}`}
              />
            </View>
          </View>

          <Field
            label="Completion evidence"
            hint="Require a changed checkout before this action can pass."
            testID={`task-workflow-form-step-evidence-${index}`}
          >
            <View style={styles.toggleRow}>
              <Text style={styles.toggleLabel}>{t("tasks.workflow.requireChanges")}</Text>
              <Switch
                value={step.requireChanges}
                onValueChange={handleRequireChanges}
                accessibilityLabel={t("tasks.workflow.requireChanges")}
                testID={`task-workflow-form-step-require-changes-${index}`}
              />
            </View>
          </Field>

          <Field
            label="Check command"
            hint="Optional command that must pass, for example npm test."
            testID={`task-workflow-form-step-verify-${index}`}
          >
            <FormTextInput
              value={step.verifyCommand}
              onChangeText={handleVerifyCommand}
              placeholder={t("tasks.workflow.verifyPlaceholder")}
              testID={`task-workflow-form-step-verify-input-${index}`}
            />
          </Field>

          <Field
            label={t("tasks.workflow.timeoutLabel")}
            hint={t("tasks.workflow.timeoutHint")}
            testID={`task-workflow-form-step-timeout-${index}`}
          >
            <FormTextInput
              value={step.timeoutMinutes}
              onChangeText={handleTimeoutMinutes}
              placeholder={t("tasks.workflow.timeoutPlaceholder")}
              keyboardType="number-pad"
              testID={`task-workflow-form-step-timeout-input-${index}`}
            />
          </Field>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  toggleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  toggleLabel: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  step: {
    gap: theme.spacing[3],
    padding: theme.spacing[3],
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface1,
  },
  executionSummary: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    paddingTop: theme.spacing[1],
  },
  executionSummaryText: {
    flex: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  advanced: {
    gap: theme.spacing[3],
    paddingTop: theme.spacing[2],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
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
