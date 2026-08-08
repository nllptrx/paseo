import { useCallback, useMemo, type ReactElement } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { Task } from "@getpaseo/protocol/tasks/types";
import type { TaskWorkflow } from "@getpaseo/protocol/tasks/workflow";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { useToast } from "@/contexts/toast-context";
import { useTaskDelegate, useTaskPresets } from "@/tasks/use-task-delegate";
import {
  resolveProviderLabel,
  useTaskAvailableProviders,
} from "@/tasks/use-task-available-providers";
import { useTaskStepActions } from "@/tasks/use-task-workflow";
import { toErrorMessage } from "@/utils/error-messages";

export interface StartWorkSheetProps {
  serverId: string;
  task: Task | null;
  workflow: TaskWorkflow | null;
  onClose: () => void;
}

/**
 * Asked when a card lands in In Progress with nobody on it. Moving a card is a
 * statement about where the work is, and someone who drags one there means to
 * start it — but which agent, and in what checkout, is not something a drop can
 * answer on its own. Dismissing leaves the card moved and nothing running.
 */
export function StartWorkSheet({
  serverId,
  task,
  workflow,
  onClose,
}: StartWorkSheetProps): ReactElement | null {
  const { t } = useTranslation();
  const toast = useToast();
  const { presets } = useTaskPresets(serverId);
  const { providers } = useTaskAvailableProviders(serverId);
  const providerChoices = useMemo(
    () =>
      (providers ?? [])
        .filter((entry) => entry.available)
        .map((entry) => ({ value: entry.provider, label: resolveProviderLabel(entry.provider) })),
    [providers],
  );
  const { delegate, isDelegating } = useTaskDelegate(serverId);
  const { act, isActing } = useTaskStepActions(serverId);

  const taskId = task?.id ?? null;
  const firstStepId = workflow?.steps[0]?.id ?? null;

  const handleDelegate = useCallback(
    (presetId: string) => {
      if (!taskId) {
        return;
      }
      onClose();
      void delegate({ taskId, presetId }).catch((error) => {
        toast.show(toErrorMessage(error));
      });
    },
    [delegate, onClose, taskId, toast],
  );

  const handleStartAdhoc = useCallback(
    (provider: string) => {
      if (!taskId) {
        return;
      }
      onClose();
      void delegate({ taskId, agent: { provider } }).catch((error) => {
        toast.show(toErrorMessage(error));
      });
    },
    [delegate, onClose, taskId, toast],
  );

  const handleRunWorkflow = useCallback(() => {
    if (!taskId || !firstStepId) {
      return;
    }
    onClose();
    void act({ taskId, stepId: firstStepId, action: "run" }).catch((error) => {
      toast.show(toErrorMessage(error));
    });
  }, [act, firstStepId, onClose, taskId, toast]);

  const header = useMemo(
    () => ({ title: t("tasks.start.title"), subtitle: task?.title ?? "" }),
    [t, task?.title],
  );

  if (!task) {
    return null;
  }

  const busy = isDelegating || isActing;
  return (
    <AdaptiveModalSheet header={header} visible onClose={onClose} testID="task-start-work-sheet">
      <View style={styles.body}>
        {firstStepId ? (
          <Button
            variant="default"
            onPress={handleRunWorkflow}
            disabled={busy}
            testID="task-start-work-run-workflow"
          >
            {t("tasks.start.runWorkflow")}
          </Button>
        ) : null}

        {presets.map((preset) => (
          <PresetRow
            key={preset.id}
            presetId={preset.id}
            name={preset.name}
            disabled={busy}
            onStart={handleDelegate}
          />
        ))}

        <View style={styles.adhoc}>
          <Text style={styles.adhocHeading}>{t("tasks.start.adhocHeading")}</Text>
          <View style={styles.adhocRow}>
            {providerChoices.map((choice) => (
              <ProviderButton
                key={choice.value}
                provider={choice.value}
                label={choice.label}
                disabled={busy}
                onStart={handleStartAdhoc}
              />
            ))}
          </View>
          {providerChoices.length === 0 ? (
            <Text style={styles.empty}>{t("tasks.start.noProviders")}</Text>
          ) : null}
        </View>

        <Button variant="ghost" onPress={onClose} testID="task-start-work-skip">
          {t("tasks.start.justMove")}
        </Button>
      </View>
    </AdaptiveModalSheet>
  );
}

/** Starting once, without saving a way of working first. The preset list is
 * the repeatable path; this is the one-off beside it. */
function ProviderButton({
  provider,
  label,
  disabled,
  onStart,
}: {
  provider: string;
  label: string;
  disabled: boolean;
  onStart: (provider: string) => void;
}): ReactElement {
  const handlePress = useCallback(() => onStart(provider), [onStart, provider]);
  return (
    <Button
      variant="ghost"
      size="sm"
      onPress={handlePress}
      disabled={disabled}
      testID={`task-start-work-provider-${provider}`}
    >
      {label}
    </Button>
  );
}

function PresetRow({
  presetId,
  name,
  disabled,
  onStart,
}: {
  presetId: string;
  name: string;
  disabled: boolean;
  onStart: (presetId: string) => void;
}): ReactElement {
  const handlePress = useCallback(() => onStart(presetId), [onStart, presetId]);
  return (
    <Button
      variant="outline"
      onPress={handlePress}
      disabled={disabled}
      testID={`task-start-work-preset-${presetId}`}
    >
      {name}
    </Button>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: {
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
    paddingTop: theme.spacing[2],
    paddingBottom: theme.spacing[4],
  },
  adhoc: {
    gap: theme.spacing[2],
    paddingTop: theme.spacing[2],
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
  },
  adhocHeading: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
  },
  adhocRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  empty: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    paddingVertical: theme.spacing[2],
  },
}));
