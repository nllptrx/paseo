import { useCallback, useMemo, type ReactElement, type ReactNode } from "react";
import { StyleSheet } from "react-native-unistyles";
import type { AgentProvider } from "@getpaseo/protocol/agent-types";
import { CombinedModelSelector } from "@/components/combined-model-selector";
import { Field } from "@/components/ui/form-field";
import { SelectFieldTrigger } from "@/components/ui/select-field";
import type { FieldControlSize } from "@/components/ui/control-geometry";
import { getProviderIcon } from "@/components/provider-icons";
import { ICON_SIZE } from "@/styles/theme";
import { buildSelectableProviderSelectorProviders } from "@/provider-selection/provider-selection";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";

export interface AgentModelFieldProps {
  serverId: string;
  label: string;
  hint?: string | undefined;
  /** The checkout providers are resolved against. Omitted for a choice that is
   * not tied to one — a host-wide preset has no checkout in hand. */
  cwd?: string | null | undefined;
  provider: AgentProvider | null;
  model: string | null;
  onSelect: (selection: { provider: AgentProvider; model: string | null }) => void;
  placeholder: string;
  size?: FieldControlSize;
  disabled?: boolean;
  testID: string;
}

/**
 * Choosing which agent runs something: one control for the provider and its
 * model, the same one the composer and the schedule form use.
 *
 * Provider and model are picked together because a model id only means anything
 * under the provider that offers it — two lists let someone pair a model with a
 * provider that has never heard of it.
 */
export function AgentModelField({
  serverId,
  label,
  hint,
  cwd,
  provider,
  model,
  onSelect,
  placeholder,
  size = "md",
  disabled = false,
  testID,
}: AgentModelFieldProps): ReactElement {
  const snapshot = useProvidersSnapshot(serverId, { cwd: cwd ?? null });
  const providers = useMemo(
    () => buildSelectableProviderSelectorProviders(snapshot.entries),
    [snapshot.entries],
  );

  const handleSelect = useCallback(
    (selectedProvider: AgentProvider, modelId: string) => {
      onSelect({ provider: selectedProvider, model: modelId || null });
    },
    [onSelect],
  );

  const handleRetryProvider = useCallback(
    (retried: AgentProvider) => {
      void snapshot.refresh([retried]);
    },
    [snapshot],
  );

  const leading = useMemo(() => {
    if (!provider) {
      return null;
    }
    const Icon = getProviderIcon(provider);
    return <Icon size={ICON_SIZE.sm} color={styles.providerIcon.color} />;
  }, [provider]);

  const renderTrigger = useCallback(
    (input: {
      selectedModelLabel: string;
      disabled: boolean;
      isOpen: boolean;
      hovered: boolean;
      pressed: boolean;
    }): ReactNode => (
      <SelectFieldTrigger
        label={input.selectedModelLabel || placeholder}
        isPlaceholder={!model && !provider}
        placeholder={placeholder}
        leading={leading}
        disabled={input.disabled}
        active={input.hovered || input.pressed || input.isOpen}
        size={size}
        testID={`${testID}-trigger`}
      />
    ),
    [leading, model, placeholder, provider, size, testID],
  );

  return (
    <Field label={label} hint={hint} testID={testID}>
      <CombinedModelSelector
        providers={providers}
        selectedProvider={provider ?? ""}
        selectedModel={model ?? ""}
        onSelect={handleSelect}
        isLoading={snapshot.isLoading || snapshot.isFetching}
        renderTrigger={renderTrigger}
        triggerFill
        serverId={serverId}
        disabled={disabled}
        onRetryProvider={handleRetryProvider}
        isRetryingProvider={snapshot.isRefreshing}
      />
    </Field>
  );
}

const styles = StyleSheet.create((theme) => ({
  providerIcon: {
    color: theme.colors.foregroundMuted,
  },
}));
