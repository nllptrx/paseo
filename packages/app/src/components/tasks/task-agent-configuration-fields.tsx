import { useCallback, useMemo, type ReactElement } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type {
  AgentFeatureToggle,
  AgentMode,
  AgentModelDefinition,
  AgentProvider,
  AgentSelectOption,
  ProviderSnapshotEntry,
} from "@getpaseo/protocol/agent-types";
import { formatThinkingOptionLabel } from "@/agent-controls/labels";
import { AgentModelField } from "@/components/agents/agent-model-field";
import {
  SelectField,
  type SelectFieldDisplay,
  type SelectFieldOption,
} from "@/components/ui/select-field";
import { Switch } from "@/components/ui/switch";
import { useDraftAgentFeatures } from "@/hooks/use-draft-agent-features";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";

const EMPTY_MODES: AgentMode[] = [];
const EMPTY_THINKING_OPTIONS: AgentSelectOption[] = [];

export interface TaskAgentConfigurationFieldsProps {
  serverId: string;
  cwd?: string | null;
  label: string;
  hint?: string;
  provider: AgentProvider | null;
  model: string | null;
  modeId: string | null;
  thinkingOptionId: string | null;
  featureValues?: Record<string, unknown>;
  onSelectAgent: (selection: { provider: AgentProvider; model: string | null }) => void;
  onSelectMode: (modeId: string | null) => void;
  onSelectThinking: (thinkingOptionId: string | null) => void;
  onChangeFeatureValues: (featureValues: Record<string, unknown> | undefined) => void;
  placeholder: string;
  testID: string;
}

function resolveModel(
  entry: ProviderSnapshotEntry | null,
  modelId: string | null,
): AgentModelDefinition | null {
  const models = entry?.models ?? [];
  return (
    models.find((candidate) => candidate.id === modelId) ??
    models.find((candidate) => candidate.isDefault) ??
    models[0] ??
    null
  );
}

/** The complete way a Kanban agent runs. Every task surface uses this component
 * so model selection cannot silently drop effort, permissions, or features. */
export function TaskAgentConfigurationFields({
  serverId,
  cwd = null,
  label,
  hint,
  provider,
  model,
  modeId,
  thinkingOptionId,
  featureValues,
  onSelectAgent,
  onSelectMode,
  onSelectThinking,
  onChangeFeatureValues,
  placeholder,
  testID,
}: TaskAgentConfigurationFieldsProps): ReactElement {
  const { t } = useTranslation();
  const providerSnapshot = useProvidersSnapshot(serverId, { cwd });
  const providerEntry = useMemo(
    () => providerSnapshot.entries?.find((entry) => entry.provider === provider) ?? null,
    [provider, providerSnapshot.entries],
  );
  const selectedModel = resolveModel(providerEntry, model);
  const modeOptions = providerEntry?.modes ?? EMPTY_MODES;
  const thinkingOptions = selectedModel?.thinkingOptions ?? EMPTY_THINKING_OPTIONS;
  const { features, setFeatureValue } = useDraftAgentFeatures({
    serverId,
    provider,
    cwd,
    modeId,
    modelId: selectedModel?.id ?? model,
    thinkingOptionId,
    initialFeatureValues: featureValues,
    persistPreferences: false,
  });
  const fastFeature = useMemo(
    () =>
      features.find(
        (feature): feature is AgentFeatureToggle =>
          feature.id === "fast_mode" && feature.type === "toggle",
      ) ?? null,
    [features],
  );

  const permissionOptions = useMemo<SelectFieldOption<string>[]>(
    () => [
      { id: "default", value: "", label: t("tasks.presets.permissionDefault") },
      ...modeOptions.map((option) => ({
        id: option.id,
        value: option.id,
        label: option.label,
        description: option.description,
      })),
    ],
    [modeOptions, t],
  );
  const effortOptions = useMemo<SelectFieldOption<string>[]>(
    () => [
      { id: "default", value: "", label: t("tasks.presets.effortDefault") },
      ...thinkingOptions.map((option) => ({
        id: option.id,
        value: option.id,
        label: formatThinkingOptionLabel(option),
        description: option.description,
      })),
    ],
    [t, thinkingOptions],
  );
  const permissionDisplay = useMemo<SelectFieldDisplay>(
    () => ({
      label:
        modeOptions.find((option) => option.id === modeId)?.label ??
        t("tasks.presets.permissionDefault"),
    }),
    [modeId, modeOptions, t],
  );
  const effortDisplay = useMemo<SelectFieldDisplay>(
    () => ({
      label: thinkingOptionId
        ? formatThinkingOptionLabel(
            thinkingOptions.find((option) => option.id === thinkingOptionId) ?? {
              id: thinkingOptionId,
              label: thinkingOptionId,
            },
          )
        : t("tasks.presets.effortDefault"),
    }),
    [t, thinkingOptionId, thinkingOptions],
  );

  const handleSelectAgent = useCallback(
    (selection: { provider: AgentProvider; model: string | null }) => {
      const entry = providerSnapshot.entries?.find(
        (candidate) => candidate.provider === selection.provider,
      );
      const nextModel = resolveModel(entry ?? null, selection.model);
      onSelectAgent(selection);
      onSelectMode(entry?.defaultModeId ?? null);
      onSelectThinking(
        nextModel?.defaultThinkingOptionId ??
          nextModel?.thinkingOptions?.find((option) => option.isDefault)?.id ??
          null,
      );
      if (selection.provider !== provider) {
        onChangeFeatureValues(undefined);
      }
    },
    [
      onChangeFeatureValues,
      onSelectAgent,
      onSelectMode,
      onSelectThinking,
      provider,
      providerSnapshot.entries,
    ],
  );
  const handleSelectMode = useCallback(
    (value: string) => onSelectMode(value || null),
    [onSelectMode],
  );
  const handleSelectThinking = useCallback(
    (value: string) => onSelectThinking(value || null),
    [onSelectThinking],
  );
  const handleFastModeChange = useCallback(
    (value: boolean) => {
      setFeatureValue("fast_mode", value);
      onChangeFeatureValues({ ...featureValues, fast_mode: value });
    },
    [featureValues, onChangeFeatureValues, setFeatureValue],
  );

  return (
    <View style={styles.container} testID={`${testID}-configuration`}>
      <AgentModelField
        serverId={serverId}
        cwd={cwd}
        label={label}
        hint={hint}
        provider={provider}
        model={model}
        onSelect={handleSelectAgent}
        placeholder={placeholder}
        testID={testID}
      />
      {thinkingOptions.length > 0 ? (
        <SelectField
          label={t("tasks.presets.effortLabel")}
          value={thinkingOptionId ?? ""}
          selectedDisplay={effortDisplay}
          options={effortOptions}
          onChange={handleSelectThinking}
          placeholder={t("tasks.presets.effortDefault")}
          emptyText={t("tasks.presets.noEffortOptions")}
          searchable={effortOptions.length > 7}
          title={t("tasks.presets.effortLabel")}
          triggerTestID={`${testID}-effort-trigger`}
        />
      ) : null}
      {modeOptions.length > 0 ? (
        <SelectField
          label={t("tasks.presets.permissionLabel")}
          value={modeId ?? ""}
          selectedDisplay={permissionDisplay}
          options={permissionOptions}
          onChange={handleSelectMode}
          placeholder={t("tasks.presets.permissionDefault")}
          emptyText={t("tasks.presets.noPermissionOptions")}
          searchable={permissionOptions.length > 7}
          title={t("tasks.presets.permissionLabel")}
          triggerTestID={`${testID}-permission-trigger`}
        />
      ) : null}
      {fastFeature ? (
        <View style={styles.fastModeField}>
          <View style={styles.fastModeCopy}>
            <Text style={styles.fastModeLabel}>{fastFeature.label}</Text>
            {fastFeature.description ? (
              <Text style={styles.fastModeDescription}>{fastFeature.description}</Text>
            ) : null}
          </View>
          <Switch
            value={fastFeature.value}
            onValueChange={handleFastModeChange}
            accessibilityLabel={fastFeature.label}
            testID={`${testID}-fast-mode-switch`}
          />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    gap: theme.spacing[2],
  },
  fastModeField: {
    minHeight: 40,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
  },
  fastModeCopy: {
    minWidth: 0,
    flex: 1,
    gap: theme.spacing[0.5],
  },
  fastModeLabel: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  fastModeDescription: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
}));
