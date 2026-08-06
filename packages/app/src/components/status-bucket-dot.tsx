import type { ReactElement } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { SidebarStateBucket } from "@/utils/sidebar-agent-state";

/**
 * The status dot for a surface that already holds a state bucket rather than a
 * raw agent lifecycle status — kanban cards, the Orchestrators rail. Colors come
 * from the same `statusDot*` band as `AgentStatusDot`; `done` draws nothing.
 */
export function StatusBucketDot({
  bucket,
}: {
  bucket: SidebarStateBucket | null;
}): ReactElement | null {
  if (bucket === "needs_input") return <View style={[styles.dot, styles.warning]} />;
  if (bucket === "failed") return <View style={[styles.dot, styles.danger]} />;
  if (bucket === "running") return <View style={[styles.dot, styles.running]} />;
  if (bucket === "attention") return <View style={[styles.dot, styles.success]} />;
  return null;
}

const styles = StyleSheet.create((theme) => ({
  dot: {
    width: 8,
    height: 8,
    borderRadius: theme.borderRadius.full,
  },
  warning: {
    backgroundColor: theme.colors.statusDotWarning,
  },
  danger: {
    backgroundColor: theme.colors.statusDotDanger,
  },
  running: {
    backgroundColor: theme.colors.statusDotRunning,
  },
  success: {
    backgroundColor: theme.colors.statusDotSuccess,
  },
}));
