import { Fragment, type ReactElement } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { AgentStatusDot } from "@/components/agent-status-dot";
import { resolveProviderLabel } from "@/tasks/use-task-available-providers";
import {
  TASK_EXECUTION_STATE_LABELS,
  TASK_EXECUTION_STATE_ORDER,
  type TaskExecutionState,
  type TaskExecutionSummary as TaskExecutionSummaryModel,
} from "@/tasks/task-execution";

export function TaskExecutionSummary({
  summary,
  compact = false,
}: {
  summary: TaskExecutionSummaryModel | null | undefined;
  compact?: boolean;
}): ReactElement | null {
  if (!summary || summary.totalCount === 0) {
    return null;
  }

  if (summary.totalCount === 1) {
    const entry = summary.entries[0];
    if (!entry) return null;
    return (
      <View style={styles.summary} testID="task-execution-summary">
        <TaskExecutionStateDot state={entry.state} />
        <Text style={styles.text} numberOfLines={1}>
          {compact
            ? TASK_EXECUTION_STATE_LABELS[entry.state]
            : resolveProviderLabel(entry.provider)}
          {compact ? "" : ` · ${TASK_EXECUTION_STATE_LABELS[entry.state]}`}
        </Text>
      </View>
    );
  }

  const visibleStates = TASK_EXECUTION_STATE_ORDER.filter((state) => summary.counts[state] > 0);
  return (
    <View style={styles.summary} testID="task-execution-summary">
      {visibleStates.map((state, index) => (
        <Fragment key={state}>
          {index > 0 ? <Text style={styles.separator}>·</Text> : null}
          <View style={styles.item}>
            <TaskExecutionStateDot state={state} />
            <Text style={styles.text} numberOfLines={1}>
              {summary.counts[state]} {TASK_EXECUTION_STATE_LABELS[state].toLocaleLowerCase()}
            </Text>
          </View>
        </Fragment>
      ))}
    </View>
  );
}

export function TaskExecutionStateDot({ state }: { state: TaskExecutionState }): ReactElement {
  if (state === "needs_input") {
    return (
      <AgentStatusDot status="idle" requiresAttention attentionReason="permission" showInactive />
    );
  }
  if (state === "failed") {
    return <AgentStatusDot status="error" requiresAttention={false} showInactive />;
  }
  if (state === "starting" || state === "running") {
    return <AgentStatusDot status="running" requiresAttention={false} showInactive />;
  }
  if (state === "attention" || state === "step_complete") {
    return (
      <AgentStatusDot status="idle" requiresAttention attentionReason="finished" showInactive />
    );
  }
  return <AgentStatusDot status="idle" requiresAttention={false} showInactive />;
}

const styles = StyleSheet.create((theme) => ({
  summary: {
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[1],
  },
  item: {
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  text: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  separator: {
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.xs,
  },
}));
