import { useCallback, useMemo, useState, type ReactElement } from "react";
import { Text, View, type TextStyle } from "react-native";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronUp, Settings2, Trash2 } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { isWeb } from "@/constants/platform";
import type { AgentProvider } from "@getpaseo/protocol/agent-types";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { TaskAgentConfigurationFields } from "@/components/tasks/task-agent-configuration-fields";
import { SelectField } from "@/components/ui/select-field";
import { Switch } from "@/components/ui/switch";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import {
  TASK_WORKFLOW_TRIGGER_LABEL_KEYS,
  TASK_WORKFLOW_WORKSPACE_LABEL_KEYS,
  TASK_WORKFLOW_WORKSPACE_MODES,
  type TaskWorkflowFormModel,
  type TaskWorkflowFormState,
  type TaskWorkflowFormStep,
  type TaskWorkflowFormWorkspaceMode,
} from "@/tasks/task-workflow-form-model";

const ThemedTrash = withUnistyles(Trash2);
const ThemedChevronUp = withUnistyles(ChevronUp);
const ThemedChevronDown = withUnistyles(ChevronDown);
const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const resizableBriefStyle = isWeb
  ? ({ overflowY: "auto", resize: "vertical" } as TextStyle)
  : undefined;

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
  const [expanded, setExpanded] = useState(() => !step.source);
  const [advanced, setAdvanced] = useState(
    Boolean(
      step.source &&
      (step.workspaceMode !== "worktree" ||
        step.trigger === "schedule" ||
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
  const handleMode = useCallback(
    (modeId: string | null) => model.setStepMode(key, modeId),
    [key, model],
  );
  const handleThinking = useCallback(
    (thinkingOptionId: string | null) => model.setStepThinking(key, thinkingOptionId),
    [key, model],
  );
  const handleFeatureValues = useCallback(
    (featureValues: Record<string, unknown> | undefined) =>
      model.setStepFeatureValues(key, featureValues),
    [key, model],
  );
  const handleWorkspace = useCallback(
    (mode: TaskWorkflowFormWorkspaceMode) => model.setStepWorkspaceMode(key, mode),
    [key, model],
  );
  const handleRemove = useCallback(() => model.removeStep(key), [key, model]);
  const handleMoveUp = useCallback(() => model.moveStep(key, -1), [key, model]);
  const handleMoveDown = useCallback(() => model.moveStep(key, 1), [key, model]);
  const toggleAdvanced = useCallback(() => setAdvanced((value) => !value), []);
  const toggleExpanded = useCallback(() => setExpanded((value) => !value), []);
  const toggleIcon = useMemo(
    () =>
      expanded ? (
        <ThemedChevronUp size={ICON_SIZE.sm} uniProps={mutedIconMapping} />
      ) : (
        <ThemedChevronDown size={ICON_SIZE.sm} uniProps={mutedIconMapping} />
      ),
    [expanded],
  );
  const toggleAccessibilityState = useMemo(() => ({ expanded }), [expanded]);

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

  const executionSummary =
    step.trigger === "schedule"
      ? `${workspaceDisplay.label} · ${t(TASK_WORKFLOW_TRIGGER_LABEL_KEYS.schedule)}`
      : workspaceDisplay.label;

  return (
    <View style={styles.step} testID={`task-workflow-form-step-${index}`}>
      <View style={styles.header}>
        <Button
          variant="ghost"
          size="sm"
          style={styles.stepToggle}
          textStyle={styles.heading}
          trailing={toggleIcon}
          onPress={toggleExpanded}
          accessibilityState={toggleAccessibilityState}
          testID={`task-workflow-form-step-toggle-${index}`}
        >
          {t("tasks.workflow.stepHeading", { index: index + 1, total: stepCount })}
        </Button>
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

      {expanded ? (
        <>
          <Field label="Step" testID={`task-workflow-form-step-name-${index}`}>
            <FormTextInput
              initialValue={step.name}
              resetKey={step.key}
              value={step.name}
              onChangeText={handleName}
              placeholder="Build, verify, document…"
              testID={`task-workflow-form-step-name-input-${index}`}
            />
          </Field>

          <Field
            label="Agent brief"
            hint="The task title and description are included automatically. Add only what this step needs."
            testID={`task-workflow-form-step-prompt-${index}`}
          >
            <FormTextInput
              initialValue={step.prompt}
              resetKey={step.key}
              value={step.prompt}
              onChangeText={handlePrompt}
              placeholder="What should the agent do in this step?"
              multiline
              style={resizableBriefStyle}
              testID={`task-workflow-form-step-prompt-input-${index}`}
            />
          </Field>

          <TaskAgentConfigurationFields
            serverId={state.serverId}
            cwd={state.cwd}
            label={t("tasks.workflow.agentLabel")}
            provider={step.provider}
            model={step.model}
            modeId={step.modeId}
            thinkingOptionId={step.thinkingOptionId}
            featureValues={step.featureValues}
            onSelectAgent={handleAgent}
            onSelectMode={handleMode}
            onSelectThinking={handleThinking}
            onChangeFeatureValues={handleFeatureValues}
            placeholder={t("tasks.workflow.providerPlaceholder")}
            testID={`task-workflow-form-agent-${index}`}
          />
          <View style={styles.executionSummary}>
            <Text style={styles.executionSummaryText}>{executionSummary}</Text>
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
            <View
              style={styles.advanced}
              testID={`task-workflow-form-step-advanced-fields-${index}`}
            >
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

              <Field
                label="Completion evidence"
                hint="Require a changed checkout before this step can pass."
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
                  initialValue={step.verifyCommand}
                  resetKey={step.key}
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
                  initialValue={step.timeoutMinutes}
                  resetKey={step.key}
                  value={step.timeoutMinutes}
                  onChangeText={handleTimeoutMinutes}
                  placeholder={t("tasks.workflow.timeoutPlaceholder")}
                  keyboardType="number-pad"
                  testID={`task-workflow-form-step-timeout-input-${index}`}
                />
              </Field>
            </View>
          ) : null}
        </>
      ) : (
        <View style={styles.collapsedSummary}>
          <Text style={styles.collapsedSummaryText} numberOfLines={1}>
            {step.name || "Untitled step"}
          </Text>
          <Text style={styles.executionSummaryText} numberOfLines={1}>
            {step.provider ?? "No agent"} · {executionSummary}
          </Text>
        </View>
      )}
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
  collapsedSummary: {
    gap: theme.spacing[1],
  },
  collapsedSummaryText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
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
  stepToggle: {
    flex: 1,
    justifyContent: "flex-start",
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
