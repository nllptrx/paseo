import { useCallback, useMemo, useRef, useState, type ReactElement } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { Link2, ListPlus } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import type { Task, TaskProject } from "@getpaseo/protocol/tasks/types";
import { Button } from "@/components/ui/button";
import { Combobox, type ComboboxOption } from "@/components/ui/combobox";
import { resolveProviderLabel } from "@/tasks/use-task-available-providers";
import { TASK_EXECUTION_STATE_LABELS, type TaskExecutionEntry } from "@/tasks/task-execution";
import { TaskExecutionStateDot } from "./task-execution-summary";
import { TASK_STATUS_LABEL_KEYS } from "./task-board-parts";
import { useTranslation } from "react-i18next";

export interface UntrackedTaskWorkProps {
  entries: readonly TaskExecutionEntry[];
  tasks: readonly Task[];
  projectsById: ReadonlyMap<string, TaskProject>;
  onOpenAgent: (input: { workspaceId: string; agentId: string }) => void;
  onCreateTask: (entry: TaskExecutionEntry) => void;
  onAttachTask: (input: { taskId: string; agentId: string; workspaceId: string }) => Promise<void>;
}

export function UntrackedTaskWork({
  entries,
  tasks,
  projectsById,
  onOpenAgent,
  onCreateTask,
  onAttachTask,
}: UntrackedTaskWorkProps): ReactElement | null {
  const { t } = useTranslation();
  const taskOptions = useMemo<ComboboxOption[]>(
    () =>
      tasks
        .filter((task) => task.status !== "done" && task.status !== "canceled")
        .map((task) => {
          const project = projectsById.get(task.projectId);
          const key = project ? `${project.prefix}-${task.number}` : String(task.number);
          return {
            id: task.id,
            label: `${key} ${task.title}`,
            description: t(TASK_STATUS_LABEL_KEYS[task.status]),
          };
        }),
    [projectsById, t, tasks],
  );

  if (entries.length === 0) return null;

  return (
    <View style={styles.section} testID="tasks-untracked-work">
      <View style={styles.header}>
        <Text style={styles.heading}>{t("tasks.threads.untracked")}</Text>
        <Text style={styles.count}>{entries.length}</Text>
        <Text style={styles.hint} numberOfLines={1}>
          Chats in this project that are not attached to a task
        </Text>
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.cards}
      >
        {entries.map((entry) => (
          <UntrackedTaskWorkCard
            key={entry.agentId}
            entry={entry}
            taskOptions={taskOptions}
            onOpenAgent={onOpenAgent}
            onCreateTask={onCreateTask}
            onAttachTask={onAttachTask}
          />
        ))}
      </ScrollView>
    </View>
  );
}

function UntrackedTaskWorkCard({
  entry,
  taskOptions,
  onOpenAgent,
  onCreateTask,
  onAttachTask,
}: {
  entry: TaskExecutionEntry;
  taskOptions: ComboboxOption[];
  onOpenAgent: UntrackedTaskWorkProps["onOpenAgent"];
  onCreateTask: UntrackedTaskWorkProps["onCreateTask"];
  onAttachTask: UntrackedTaskWorkProps["onAttachTask"];
}): ReactElement {
  const anchorRef = useRef<View>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [attaching, setAttaching] = useState(false);
  const providerLabel = resolveProviderLabel(entry.provider);
  const handleOpenAgent = useCallback(
    () => onOpenAgent({ workspaceId: entry.workspaceId, agentId: entry.agentId }),
    [entry.agentId, entry.workspaceId, onOpenAgent],
  );
  const handleCreateTask = useCallback(() => onCreateTask(entry), [entry, onCreateTask]);
  const handleSelectTask = useCallback(
    (taskId: string) => {
      setPickerOpen(false);
      setAttaching(true);
      void onAttachTask({
        taskId,
        agentId: entry.agentId,
        workspaceId: entry.workspaceId,
      }).finally(() => setAttaching(false));
    },
    [entry.agentId, entry.workspaceId, onAttachTask],
  );
  const handleOpenPicker = useCallback(() => setPickerOpen(true), []);

  return (
    <View style={styles.card} testID={`tasks-untracked-${entry.agentId}`}>
      <Pressable onPress={handleOpenAgent} accessibilityRole="button" style={styles.cardBody}>
        <Text style={styles.title} numberOfLines={1}>
          {entry.title?.trim() || `${providerLabel} chat`}
        </Text>
        <View style={styles.metadata}>
          <TaskExecutionStateDot state={entry.state} />
          <Text style={styles.metadataText} numberOfLines={1}>
            {TASK_EXECUTION_STATE_LABELS[entry.state]} · {entry.workspaceName}
          </Text>
        </View>
      </Pressable>
      <View style={styles.actions}>
        <Button
          variant="ghost"
          size="xs"
          leftIcon={ListPlus}
          onPress={handleCreateTask}
          testID={`tasks-untracked-create-${entry.agentId}`}
        >
          Create task
        </Button>
        <View ref={anchorRef} collapsable={false}>
          <Button
            variant="ghost"
            size="xs"
            leftIcon={Link2}
            onPress={handleOpenPicker}
            disabled={taskOptions.length === 0}
            loading={attaching}
            testID={`tasks-untracked-attach-${entry.agentId}`}
          >
            Attach
          </Button>
        </View>
        <Combobox
          options={taskOptions}
          value=""
          onSelect={handleSelectTask}
          open={pickerOpen}
          onOpenChange={setPickerOpen}
          anchorRef={anchorRef}
          searchable
          title="Attach to task"
          searchPlaceholder="Search tasks"
          emptyText="No open tasks"
          desktopMinWidth={320}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  section: {
    flexShrink: 0,
    gap: theme.spacing[2],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
  },
  header: {
    minWidth: 0,
    flexDirection: "row",
    alignItems: "baseline",
    gap: theme.spacing[2],
  },
  heading: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  count: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  hint: {
    minWidth: 0,
    flexShrink: 1,
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.xs,
  },
  cards: {
    gap: theme.spacing[2],
  },
  card: {
    width: 300,
    gap: theme.spacing[2],
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface1,
    padding: theme.spacing[3],
  },
  cardBody: {
    minWidth: 0,
    gap: theme.spacing[1],
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  metadata: {
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  metadataText: {
    minWidth: 0,
    flexShrink: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
}));
