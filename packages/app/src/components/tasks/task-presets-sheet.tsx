import { useCallback, useMemo, useState, type ReactElement } from "react";
import { Text, TextInput, View } from "react-native";
import { useTranslation } from "react-i18next";
import { Trash2 } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { TaskPreset } from "@getpaseo/protocol/tasks/types";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { useToast } from "@/contexts/toast-context";
import {
  resolveProviderLabel,
  useTaskAvailableProviders,
} from "@/tasks/use-task-available-providers";
import { useTaskPresetMutations, useTaskPresets } from "@/tasks/use-task-delegate";
import { toErrorMessage } from "@/utils/error-messages";
import { ICON_SIZE, type Theme } from "@/styles/theme";

const ThemedTrash = withUnistyles(Trash2);
const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

type EnvironmentKind = "project_default" | "new_worktree";

export interface TaskPresetsSheetProps {
  serverId: string;
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
  visible,
  onClose,
}: TaskPresetsSheetProps): ReactElement | null {
  if (!visible) {
    return null;
  }
  return <OpenTaskPresetsSheet serverId={serverId} onClose={onClose} />;
}

function OpenTaskPresetsSheet({
  serverId,
  onClose,
}: {
  serverId: string;
  onClose: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const toast = useToast();
  const { presets } = useTaskPresets(serverId);
  const { createPreset, deletePreset, isBusy } = useTaskPresetMutations(serverId);
  const { providers } = useTaskAvailableProviders(serverId);

  const [name, setName] = useState("");
  const [instructions, setInstructions] = useState("");
  const [provider, setProvider] = useState<string | null>(null);
  const [environmentKind, setEnvironmentKind] = useState<EnvironmentKind>("new_worktree");

  const providerChoices = useMemo(
    () =>
      (providers ?? [])
        .filter((entry) => entry.available)
        .map((entry) => ({ value: entry.provider, label: resolveProviderLabel(entry.provider) })),
    [providers],
  );
  const selectedProvider = provider ?? providerChoices[0]?.value ?? null;
  const canSave = name.trim().length > 0 && selectedProvider !== null && !isBusy;

  const handleSave = useCallback(() => {
    if (!canSave || !selectedProvider) {
      return;
    }
    void (async () => {
      try {
        await createPreset({
          name: name.trim(),
          provider: selectedProvider,
          instructions: instructions.trim(),
          environmentKind,
        });
        setName("");
        setInstructions("");
      } catch (error) {
        toast.show(toErrorMessage(error));
      }
    })();
  }, [canSave, createPreset, environmentKind, instructions, name, selectedProvider, toast]);

  const handleDelete = useCallback(
    (presetId: string) => {
      void deletePreset(presetId).catch((error) => {
        toast.show(toErrorMessage(error));
      });
    },
    [deletePreset, toast],
  );

  const header = useMemo(() => ({ title: t("tasks.presets.title") }), [t]);

  return (
    <AdaptiveModalSheet header={header} visible onClose={onClose} testID="task-presets-sheet">
      <View style={styles.body}>
        {presets.length === 0 ? (
          <Text style={styles.empty}>{t("tasks.presets.empty")}</Text>
        ) : (
          presets.map((preset) => (
            <PresetRow key={preset.id} preset={preset} disabled={isBusy} onDelete={handleDelete} />
          ))
        )}

        <View style={styles.form}>
          <Text style={styles.formHeading}>{t("tasks.presets.newHeading")}</Text>
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder={t("tasks.presets.namePlaceholder")}
            placeholderTextColor={styles.placeholder.color}
            style={styles.input}
            testID="task-presets-name-input"
          />
          <View style={styles.choices}>
            {providerChoices.map((choice) => (
              <ChoiceButton
                key={choice.value}
                value={choice.value}
                label={choice.label}
                selected={choice.value === selectedProvider}
                onSelect={setProvider}
                testID={`task-presets-provider-${choice.value}`}
              />
            ))}
          </View>
          <View style={styles.choices}>
            <ChoiceButton
              value="new_worktree"
              label={t("tasks.presets.newWorktree")}
              selected={environmentKind === "new_worktree"}
              onSelect={setEnvironmentKind}
              testID="task-presets-env-new_worktree"
            />
            <ChoiceButton
              value="project_default"
              label={t("tasks.presets.projectDefault")}
              selected={environmentKind === "project_default"}
              onSelect={setEnvironmentKind}
              testID="task-presets-env-project_default"
            />
          </View>
          <TextInput
            value={instructions}
            onChangeText={setInstructions}
            placeholder={t("tasks.presets.instructionsPlaceholder")}
            placeholderTextColor={styles.placeholder.color}
            style={[styles.input, styles.instructions]}
            multiline
            testID="task-presets-instructions-input"
          />
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

function PresetRow({
  preset,
  disabled,
  onDelete,
}: {
  preset: TaskPreset;
  disabled: boolean;
  onDelete: (presetId: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  const handleDelete = useCallback(() => onDelete(preset.id), [onDelete, preset.id]);
  const environment =
    preset.environmentKind === "new_worktree"
      ? t("tasks.presets.newWorktree")
      : t("tasks.presets.projectDefault");

  return (
    <View style={styles.row} testID={`task-presets-row-${preset.id}`}>
      <View style={styles.rowText}>
        <Text style={styles.rowName} numberOfLines={1}>
          {preset.name}
        </Text>
        <Text style={styles.rowMeta} numberOfLines={1}>
          {resolveProviderLabel(preset.provider)}
          {preset.model ? ` · ${preset.model}` : ""} · {environment}
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

function ChoiceButton<T extends string>({
  value,
  label,
  selected,
  onSelect,
  testID,
}: {
  value: T;
  label: string;
  selected: boolean;
  onSelect: (value: T) => void;
  testID: string;
}): ReactElement {
  const handlePress = useCallback(() => onSelect(value), [onSelect, value]);
  return (
    <Button
      variant={selected ? "default" : "outline"}
      size="sm"
      onPress={handlePress}
      testID={testID}
    >
      {label}
    </Button>
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
    fontWeight: theme.fontWeight.medium,
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
