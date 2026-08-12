import { useCallback, useMemo, useState, type ReactElement } from "react";
import { Text, View, type TextStyle } from "react-native";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronUp, Settings2, Trash2 } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { isWeb } from "@/constants/platform";
import type { AgentProvider } from "@getpaseo/protocol/agent-types";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { TaskAgentControlsRow } from "@/components/tasks/task-agent-controls-row";
import { Switch } from "@/components/ui/switch";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import {
  TASK_WORKFLOW_TRIGGER_LABEL_KEYS,
  TASK_WORKFLOW_WORKSPACE_LABEL_KEYS,
  TASK_WORKFLOW_WORKSPACE_MODES,
  type TaskWorkflowFormModel,
  type TaskWorkflowFormState,
  type TaskWorkflowFormStep,
} from "@/tasks/task-workflow-form-model";

const ThemedTrash = withUnistyles(Trash2);
const ThemedChevronUp = withUnistyles(ChevronUp);
const ThemedChevronDown = withUnistyles(ChevronDown);
const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
/** The step's ordinal, sized to sit under the name input rather than beside a
 * heading — off the type scale because it is a list marker, not text. */
const STEP_INDEX_FONT_SIZE = 11;
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
  const handleSelectWorkspaceId = useCallback(
    (id: string) => {
      const selected = workspaceOptions.find((option) => option.id === id);
      if (!selected) return;
      model.setStepWorkspaceMode(key, selected.value);
    },
    [key, model, workspaceOptions],
  );
  const workspaceControl = useMemo(
    () => ({
      selectedLabel: workspaceDisplay.label,
      options: workspaceOptions,
      selectedId: step.workspaceMode,
      onSelect: handleSelectWorkspaceId,
      menuTitle: t("tasks.workflow.workspaceLabel"),
      testID: `task-workflow-form-workspace-trigger-${index}`,
    }),
    [
      handleSelectWorkspaceId,
      index,
      step.workspaceMode,
      t,
      workspaceDisplay.label,
      workspaceOptions,
    ],
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
      <View style={styles.identityRow}>
        <Text style={styles.stepIndex}>{formatStepIndex(index)}</Text>
        <View style={styles.identityInput}>
          <FormTextInput
            initialValue={step.name}
            resetKey={step.key}
            value={step.name}
            onChangeText={handleName}
            placeholder="Build, verify, document…"
            style={styles.fieldSurface}
            testID={`task-workflow-form-step-name-input-${index}`}
          />
        </View>
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

      <FormTextInput
        initialValue={step.prompt}
        resetKey={step.key}
        value={step.prompt}
        onChangeText={handlePrompt}
        placeholder="What should the agent do in this step?"
        multiline
        style={[resizableBriefStyle, styles.fieldSurface]}
        testID={`task-workflow-form-step-prompt-input-${index}`}
      />

      <View style={styles.controls}>
        <TaskAgentControlsRow
          serverId={state.serverId}
          cwd={state.cwd}
          provider={step.provider}
          model={step.model}
          modeId={step.modeId}
          thinkingOptionId={step.thinkingOptionId}
          featureValues={step.featureValues}
          onSelectAgent={handleAgent}
          onSelectMode={handleMode}
          onSelectThinking={handleThinking}
          onChangeFeatureValues={handleFeatureValues}
          workspace={workspaceControl}
          testID={`task-workflow-form-agent-${index}`}
        />
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
      {step.trigger === "schedule" ? (
        <Text style={styles.executionSummaryText}>{executionSummary}</Text>
      ) : null}

      {advanced ? (
        <View style={styles.advanced} testID={`task-workflow-form-step-advanced-fields-${index}`}>
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
              style={styles.fieldSurface}
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
              style={styles.fieldSurface}
              testID={`task-workflow-form-step-timeout-input-${index}`}
            />
          </Field>
        </View>
      ) : null}
    </View>
  );
}

/** Steps read as a numbered list, so the index is zero-padded like the plan
 * prints it rather than counted out as "step 1 of 4". */
function formatStepIndex(index: number): string {
  return String(index + 1).padStart(2, "0");
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
    gap: theme.spacing[4],
    paddingTop: theme.spacing[3],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  /** Text in a step sits on the same surface as text everywhere else in the
   * task, so a step does not read as a denser kind of form. */
  fieldSurface: {
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  identityRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  stepIndex: {
    color: theme.colors.foregroundExtraMuted,
    fontFamily: theme.fontFamily.mono,
    fontSize: STEP_INDEX_FONT_SIZE,
    fontWeight: theme.fontWeight.semibold,
  },
  identityInput: {
    flex: 1,
    minWidth: 0,
  },
  headerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  controls: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
}));
