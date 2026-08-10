import { useCallback, useMemo, useState, type ReactElement } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { Trash2 } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { TaskPreset } from "@getpaseo/protocol/tasks/types";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import type { AgentProvider } from "@getpaseo/protocol/agent-types";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { TaskAgentConfigurationFields } from "@/components/tasks/task-agent-configuration-fields";
import { useToast } from "@/contexts/toast-context";
import { confirmDialog } from "@/utils/confirm-dialog";
import { resolveProviderLabel } from "@/tasks/use-task-available-providers";
import { useTaskPresetMutations, useTaskPresets } from "@/tasks/use-task-delegate";
import { useKanbanProjectCwd } from "@/tasks/use-kanban-project-cwd";
import { toErrorMessage } from "@/utils/error-messages";
import { ICON_SIZE, type Theme } from "@/styles/theme";

const ThemedTrash = withUnistyles(Trash2);
const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

type EnvironmentKind = "project_default" | "new_worktree";

export interface TaskPresetsSheetProps {
  serverId: string;
  paseoProjectId?: string | null;
  visible: boolean;
  onClose: () => void;
}

/**
 * The named ways to run work on a card: which agent, which model, and where it
 * runs. They are host-wide — a way of working is not a property of one board —
 * and everything that starts work reads from this list, including review.
 */
export function TaskPresetsSheet({
  serverId,
  paseoProjectId,
  visible,
  onClose,
}: TaskPresetsSheetProps): ReactElement | null {
  if (!visible) {
    return null;
  }
  return (
    <OpenTaskPresetsSheet
      serverId={serverId}
      paseoProjectId={paseoProjectId ?? null}
      onClose={onClose}
    />
  );
}

function OpenTaskPresetsSheet({
  serverId,
  paseoProjectId,
  onClose,
}: {
  serverId: string;
  paseoProjectId: string | null;
  onClose: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const toast = useToast();
  const { presets, isLoading } = useTaskPresets(serverId);
  const { createPreset, deletePreset, isBusy } = useTaskPresetMutations(serverId);
  const cwd = useKanbanProjectCwd(serverId, paseoProjectId);

  const [name, setName] = useState("");
  const [model, setModel] = useState<string | null>(null);
  const [instructions, setInstructions] = useState("");
  const [provider, setProvider] = useState<AgentProvider | null>(null);
  const [modeId, setModeId] = useState<string | null>(null);
  const [thinkingOptionId, setThinkingOptionId] = useState<string | null>(null);
  const [featureValues, setFeatureValues] = useState<Record<string, unknown> | undefined>();
  const [environmentKind, setEnvironmentKind] = useState<EnvironmentKind>("new_worktree");

  const environmentOptions = useMemo(
    () => [
      {
        value: "new_worktree" as const,
        label: t("tasks.presets.newWorktree"),
        testID: "task-presets-env-new_worktree",
      },
      {
        value: "project_default" as const,
        label: t("tasks.presets.projectDefault"),
        testID: "task-presets-env-project_default",
      },
    ],
    [t],
  );
  const canSave = name.trim().length > 0 && provider !== null && !isBusy;

  const handleSave = useCallback(() => {
    if (!canSave || !provider) {
      return;
    }
    void (async () => {
      try {
        await createPreset({
          name: name.trim(),
          provider: provider,
          model,
          modeId,
          thinkingOptionId,
          featureValues,
          instructions: instructions.trim(),
          environmentKind,
        });
        setName("");
        setModel(null);
        setModeId(null);
        setThinkingOptionId(null);
        setFeatureValues(undefined);
        setProvider(null);
        setInstructions("");
      } catch (error) {
        toast.show(toErrorMessage(error));
      }
    })();
  }, [
    canSave,
    createPreset,
    environmentKind,
    featureValues,
    instructions,
    modeId,
    model,
    name,
    provider,
    thinkingOptionId,
    toast,
  ]);

  const handleDelete = useCallback(
    (preset: TaskPreset) => {
      void (async () => {
        const confirmed = await confirmDialog({
          title: t("tasks.presets.confirmDeleteTitle"),
          message: t("tasks.presets.confirmDeleteMessage", { name: preset.name }),
          confirmLabel: t("common.actions.delete"),
          destructive: true,
        });
        if (!confirmed) {
          return;
        }
        try {
          await deletePreset(preset.id);
        } catch (error) {
          toast.show(toErrorMessage(error));
        }
      })();
    },
    [deletePreset, t, toast],
  );

  const handleSelectAgent = useCallback(
    (selection: { provider: AgentProvider; model: string | null }) => {
      setProvider(selection.provider);
      setModel(selection.model);
    },
    [],
  );

  const header = useMemo(() => ({ title: t("tasks.presets.title") }), [t]);

  return (
    <AdaptiveModalSheet header={header} visible onClose={onClose} testID="task-presets-sheet">
      <View style={styles.body}>
        <PresetList
          presets={presets}
          isLoading={isLoading}
          disabled={isBusy}
          onDelete={handleDelete}
        />

        <View style={styles.form}>
          <Text style={styles.formHeading}>{t("tasks.presets.newHeading")}</Text>
          <Field label={t("tasks.presets.nameLabel")} testID="task-presets-name">
            <FormTextInput
              value={name}
              onChangeText={setName}
              placeholder={t("tasks.presets.namePlaceholder")}
              testID="task-presets-name-input"
            />
          </Field>
          <TaskAgentConfigurationFields
            serverId={serverId}
            cwd={cwd}
            label={t("tasks.presets.agentLabel")}
            hint={t("tasks.presets.agentHint")}
            provider={provider}
            model={model}
            modeId={modeId}
            thinkingOptionId={thinkingOptionId}
            featureValues={featureValues}
            onSelectAgent={handleSelectAgent}
            onSelectMode={setModeId}
            onSelectThinking={setThinkingOptionId}
            onChangeFeatureValues={setFeatureValues}
            placeholder={t("tasks.presets.providerPlaceholder")}
            testID="task-presets-agent"
          />
          <Field label={t("tasks.presets.environmentLabel")} testID="task-presets-environment">
            <SegmentedControl
              options={environmentOptions}
              value={environmentKind}
              onValueChange={setEnvironmentKind}
              testID="task-presets-environment-control"
            />
          </Field>
          <Field label={t("tasks.presets.instructionsLabel")} testID="task-presets-instructions">
            <FormTextInput
              value={instructions}
              onChangeText={setInstructions}
              placeholder={t("tasks.presets.instructionsPlaceholder")}
              style={styles.instructions}
              multiline
              testID="task-presets-instructions-input"
            />
          </Field>
          <Button
            variant="default"
            onPress={handleSave}
            disabled={!canSave}
            testID="task-presets-save"
          >
            {t("tasks.presets.save")}
          </Button>
        </View>
      </View>
    </AdaptiveModalSheet>
  );
}

/** Loading is not emptiness: a host that has not answered yet must not read as
 * a host with nothing saved. */
function PresetList({
  presets,
  isLoading,
  disabled,
  onDelete,
}: {
  presets: readonly TaskPreset[];
  isLoading: boolean;
  disabled: boolean;
  onDelete: (preset: TaskPreset) => void;
}): ReactElement {
  const { t } = useTranslation();
  if (isLoading) {
    return <LoadingSpinner size="small" color={styles.placeholder.color} />;
  }
  if (presets.length === 0) {
    return <Text style={styles.empty}>{t("tasks.presets.empty")}</Text>;
  }
  return (
    <>
      {presets.map((preset) => (
        <PresetRow key={preset.id} preset={preset} disabled={disabled} onDelete={onDelete} />
      ))}
    </>
  );
}

function PresetRow({
  preset,
  disabled,
  onDelete,
}: {
  preset: TaskPreset;
  disabled: boolean;
  onDelete: (preset: TaskPreset) => void;
}): ReactElement {
  const { t } = useTranslation();
  const handleDelete = useCallback(() => onDelete(preset), [onDelete, preset]);
  const environment =
    preset.environmentKind === "new_worktree"
      ? t("tasks.presets.newWorktree")
      : t("tasks.presets.projectDefault");
  const execution = [
    preset.model,
    preset.thinkingOptionId,
    preset.modeId,
    preset.featureValues?.fast_mode === true ? t("tasks.presets.fastEnabled") : null,
    environment,
  ].filter((value): value is string => typeof value === "string" && value.length > 0);

  return (
    <View style={styles.row} testID={`task-presets-row-${preset.id}`}>
      <View style={styles.rowText}>
        <Text style={styles.rowName} numberOfLines={1}>
          {preset.name}
        </Text>
        <Text style={styles.rowMeta} numberOfLines={1}>
          {resolveProviderLabel(preset.provider)}
          {execution.length > 0 ? ` · ${execution.join(" · ")}` : ""}
        </Text>
      </View>
      <Button
        variant="ghost"
        size="xs"
        onPress={handleDelete}
        disabled={disabled}
        accessibilityLabel={t("common.actions.delete")}
        testID={`task-presets-delete-${preset.id}`}
      >
        <ThemedTrash size={ICON_SIZE.sm} uniProps={mutedIconMapping} />
      </Button>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: {
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    paddingTop: theme.spacing[2],
    paddingBottom: theme.spacing[4],
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  rowText: {
    flex: 1,
    gap: theme.spacing[0.5],
  },
  rowName: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
  },
  rowMeta: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  form: {
    gap: theme.spacing[2],
    paddingTop: theme.spacing[3],
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
  },
  formHeading: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  choices: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  input: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface1,
  },
  instructions: {
    minHeight: 72,
  },
  placeholder: {
    color: theme.colors.foregroundMuted,
  },
  empty: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
