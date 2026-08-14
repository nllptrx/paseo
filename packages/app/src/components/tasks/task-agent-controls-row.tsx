import { useCallback, useMemo, type ReactElement } from "react";
import { Text, View } from "react-native";
import { GitBranch } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type {
  AgentMode,
  AgentModelDefinition,
  AgentProvider,
  AgentSelectOption,
  ProviderSnapshotEntry,
} from "@getpaseo/protocol/agent-types";
import { DraftAgentControls } from "@/composer/agent-controls";
import type { MaterializedAgentProfile } from "@/agent-profiles/internal/materialize-profile";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { DropdownTrigger } from "@/components/ui/dropdown-trigger";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { useDraftAgentFeatures } from "@/hooks/use-draft-agent-features";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { filterSelectableModels } from "@/provider-selection/model-catalog";
import { buildSelectableProviderSelectorProviders } from "@/provider-selection/provider-selection";
import { buildProviderDefinitions } from "@/utils/provider-definitions";

const ThemedGitBranch = withUnistyles(GitBranch);
const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
/** The composer toolbar's control height, so the pill lines up with the agent
 * controls it sits beside. */
const CONTROL_PILL_HEIGHT = 28;
const EMPTY_MODES: AgentMode[] = [];
const EMPTY_MODELS: AgentModelDefinition[] = [];
const EMPTY_THINKING_OPTIONS: AgentSelectOption[] = [];

export interface TaskAgentControlsRowProps {
  serverId: string;
  cwd?: string | null;
  provider: AgentProvider | null;
  model: string | null;
  modeId: string | null;
  thinkingOptionId: string | null;
  featureValues?: Record<string, unknown>;
  onSelectAgent: (selection: { provider: AgentProvider; model: string | null }) => void;
  onSelectMode: (modeId: string | null) => void;
  onSelectThinking: (thinkingOptionId: string | null) => void;
  onChangeFeatureValues: (featureValues: Record<string, unknown> | undefined) => void;
  disabled?: boolean;
  /** Where the work runs. Not an agent setting, but it belongs on this row: it
   * is the same kind of choice, so it gets the same kind of control. */
  workspace?: {
    selectedLabel: string;
    options: readonly { id: string; label: string }[];
    selectedId: string;
    onSelect: (id: string) => void;
    menuTitle: string;
    testID: string;
  };
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

/**
 * How one step runs, as the composer's own control row rather than a column of
 * labelled fields. Which controls exist is the provider's business — a model
 * without effort levels shows no effort pill, a provider with no fast mode shows
 * no fast toggle — so the row is the composer's and not a task-shaped copy of
 * it. The labelled column still fits a preset, where a person is configuring one
 * agent and nothing else: see `TaskAgentConfigurationFields`.
 */
export function TaskAgentControlsRow({
  serverId,
  cwd = null,
  provider,
  model,
  modeId,
  thinkingOptionId,
  featureValues,
  onSelectAgent,
  onSelectMode,
  onSelectThinking,
  onChangeFeatureValues,
  disabled = false,
  workspace,
  testID,
}: TaskAgentControlsRowProps): ReactElement {
  const snapshot = useProvidersSnapshot(serverId, { cwd });
  const entries = snapshot.entries;
  const providerEntry = useMemo(
    () => entries?.find((entry) => entry.provider === provider) ?? null,
    [entries, provider],
  );
  const providerDefinitions = useMemo(() => buildProviderDefinitions(entries), [entries]);
  const modelSelectorProviders = useMemo(
    () => buildSelectableProviderSelectorProviders(entries),
    [entries],
  );
  const models = useMemo(
    () => filterSelectableModels(providerEntry?.models ?? null) ?? EMPTY_MODELS,
    [providerEntry],
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

  // Switching provider invalidates every choice made under the previous one, so
  // the step falls back to that provider's own defaults instead of carrying a
  // mode or an effort level the new provider never offered.
  const applyProvider = useCallback(
    (nextProvider: AgentProvider, nextModelId: string | null) => {
      const entry = entries?.find((candidate) => candidate.provider === nextProvider) ?? null;
      const nextModel = resolveModel(entry, nextModelId);
      onSelectAgent({ provider: nextProvider, model: nextModel?.id ?? nextModelId });
      if (nextProvider !== provider) {
        onSelectMode(entry?.defaultModeId ?? null);
        onSelectThinking(
          nextModel?.defaultThinkingOptionId ??
            nextModel?.thinkingOptions?.find((option) => option.isDefault)?.id ??
            null,
        );
        onChangeFeatureValues(undefined);
      }
    },
    [entries, onChangeFeatureValues, onSelectAgent, onSelectMode, onSelectThinking, provider],
  );

  const handleSelectProviderAndModel = useCallback(
    (nextProvider: AgentProvider, modelId: string) => applyProvider(nextProvider, modelId),
    [applyProvider],
  );
  const handleSelectModel = useCallback(
    (modelId: string) => {
      if (!provider) return;
      onSelectAgent({ provider, model: modelId });
      const nextModel = resolveModel(providerEntry, modelId);
      onSelectThinking(
        nextModel?.defaultThinkingOptionId ??
          nextModel?.thinkingOptions?.find((option) => option.isDefault)?.id ??
          null,
      );
    },
    [onSelectAgent, onSelectThinking, provider, providerEntry],
  );
  const handleApplyProfile = useCallback(
    (profile: MaterializedAgentProfile) => {
      const entry = entries?.find((candidate) => candidate.provider === profile.provider) ?? null;
      const nextModel = resolveModel(entry, profile.modelId || null);
      onSelectAgent({
        provider: profile.provider as AgentProvider,
        model: profile.modelId || (nextModel?.id ?? null),
      });
      onSelectMode(profile.modeId || (entry?.defaultModeId ?? null));
      onSelectThinking(profile.thinkingOptionId || null);
      onChangeFeatureValues(
        Object.keys(profile.featureValues).length > 0 ? profile.featureValues : undefined,
      );
    },
    [entries, onChangeFeatureValues, onSelectAgent, onSelectMode, onSelectThinking],
  );
  const handleSelectMode = useCallback(
    (value: string) => onSelectMode(value || null),
    [onSelectMode],
  );
  const handleSelectThinking = useCallback(
    (value: string) => onSelectThinking(value || null),
    [onSelectThinking],
  );
  const handleSetFeature = useCallback(
    (featureId: string, value: unknown) => {
      setFeatureValue(featureId, value);
      onChangeFeatureValues({ ...featureValues, [featureId]: value });
    },
    [featureValues, onChangeFeatureValues, setFeatureValue],
  );
  const handleRefreshProvider = useCallback(
    (target: AgentProvider) => void snapshot.refresh([target]),
    [snapshot],
  );
  const handleRefetchIfStale = useCallback(
    () => snapshot.refetchIfStale(provider),
    [provider, snapshot],
  );

  return (
    <View style={styles.row} testID={testID}>
      <DraftAgentControls
        providerDefinitions={providerDefinitions}
        selectedProvider={provider}
        modeOptions={modeOptions}
        selectedMode={modeId ?? ""}
        onSelectMode={handleSelectMode}
        models={models}
        selectedModel={selectedModel?.id ?? model ?? ""}
        onSelectModel={handleSelectModel}
        isModelLoading={snapshot.isLoading || providerEntry?.status === "loading"}
        modelSelectorProviders={modelSelectorProviders}
        isAllModelsLoading={snapshot.isLoading}
        onSelectProviderAndModel={handleSelectProviderAndModel}
        onApplyAgentProfile={handleApplyProfile}
        thinkingOptions={thinkingOptions}
        selectedThinkingOptionId={thinkingOptionId ?? ""}
        onSelectThinkingOption={handleSelectThinking}
        features={features}
        onSetFeature={handleSetFeature}
        onModelSelectorOpen={handleRefetchIfStale}
        onRetryModelProvider={handleRefreshProvider}
        isRetryingModelProvider={snapshot.isRefreshing}
        modelSelectorServerId={serverId}
        disabled={disabled}
        alwaysShowCarets
      />
      {workspace ? <WorkspacePill {...workspace} disabled={disabled} /> : null}
    </View>
  );
}

/** Where the step runs, shaped like the controls beside it: an icon, the current
 * choice, and a caret that says it opens. */
function WorkspacePill({
  selectedLabel,
  options,
  selectedId,
  onSelect,
  menuTitle,
  disabled,
  testID,
}: {
  selectedLabel: string;
  options: readonly { id: string; label: string }[];
  selectedId: string;
  onSelect: (id: string) => void;
  menuTitle: string;
  disabled: boolean;
  testID: string;
}): ReactElement {
  return (
    <DropdownMenu compactMode="sheet">
      <DropdownTrigger style={pillTriggerStyle} disabled={disabled} testID={testID}>
        <ThemedGitBranch size={ICON_SIZE.sm} uniProps={mutedIconMapping} />
        <Text style={styles.pillLabel} numberOfLines={1}>
          {selectedLabel}
        </Text>
      </DropdownTrigger>
      <DropdownMenuContent align="start" sheetTitle={menuTitle}>
        {options.map((option) => (
          <WorkspacePillItem
            key={option.id}
            id={option.id}
            label={option.label}
            selected={option.id === selectedId}
            onSelect={onSelect}
          />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function WorkspacePillItem({
  id,
  label,
  selected,
  onSelect,
}: {
  id: string;
  label: string;
  selected: boolean;
  onSelect: (id: string) => void;
}): ReactElement {
  const handleSelect = useCallback(() => onSelect(id), [id, onSelect]);
  return (
    <DropdownMenuItem selected={selected} onSelect={handleSelect}>
      {label}
    </DropdownMenuItem>
  );
}

const styles = StyleSheet.create((theme) => ({
  pillTrigger: {
    height: CONTROL_PILL_HEIGHT,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[1.5],
    borderRadius: theme.borderRadius.md,
  },
  pillTriggerActive: {
    backgroundColor: theme.colors.surface2,
  },
  pillLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  /** The controls measure the room they have and drop labels and carets when it
   * runs short, so the row has to claim the space rather than shrink to its
   * content — a row sized to its own contents reads as permanently cramped and
   * never shows a caret. */
  row: {
    flexGrow: 1,
    flexShrink: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
}));

const pillTriggerStyle = ({ hovered, open }: { hovered: boolean; open: boolean }) => [
  styles.pillTrigger,
  hovered || open ? styles.pillTriggerActive : null,
];
