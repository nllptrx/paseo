import { useCallback, useMemo, useState, type ReactElement } from "react";
import { Text, TextInput, View } from "react-native";
import { useTranslation } from "react-i18next";
import { SendHorizontal } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import type {
  Task,
  TaskLabel,
  TaskPreset,
  TaskPriority,
  TaskProject,
  TaskStatus,
} from "@getpaseo/protocol/tasks/types";
import { TASK_STATUSES } from "@getpaseo/protocol/tasks/types";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { DropdownTrigger } from "@/components/ui/dropdown-trigger";
import { useToast } from "@/contexts/toast-context";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { useWorkspace } from "@/stores/session-store-hooks";
import {
  formatTaskKey,
  resolveTaskLabels,
  selectBlockers,
  type TaskDependencyEdge,
} from "@/tasks/task-views";
import { useTaskDelegate, useTaskPresets } from "@/tasks/use-task-delegate";
import { useBoardFeed, useBoardFeedComposer } from "@/tasks/use-board-feed";
import { useTaskMutations } from "@/tasks/use-tasks";
import { toErrorMessage } from "@/utils/error-messages";
import { BoardFeedEntryRow } from "./board-feed-entry";
import {
  TASK_PRIORITY_LABEL_KEYS,
  TASK_STATUS_LABEL_KEYS,
  TaskLabelChips,
} from "./task-board-parts";

const TASK_PRIORITIES: readonly TaskPriority[] = ["none", "urgent", "high", "medium", "low"];

export interface TaskDetailSheetProps {
  serverId: string;
  taskId: string | null;
  tasks: readonly Task[];
  labels: readonly TaskLabel[];
  projectsById: ReadonlyMap<string, TaskProject>;
  dependencies: readonly TaskDependencyEdge[];
  onClose: () => void;
}

/**
 * A press on a card always opens this: description, status, priority, labels,
 * due date, attached agents and the task's own comments. Replaces the old
 * single-agent chat shortcut, which had no rule a user could learn.
 */
export function TaskDetailSheet({
  serverId,
  taskId,
  tasks,
  labels,
  projectsById,
  dependencies,
  onClose,
}: TaskDetailSheetProps): ReactElement | null {
  const task = taskId ? tasks.find((entry) => entry.id === taskId) : undefined;
  if (!task) {
    return null;
  }
  return (
    <OpenTaskDetailSheet
      key={task.id}
      serverId={serverId}
      task={task}
      project={projectsById.get(task.projectId)}
      projectsById={projectsById}
      tasks={tasks}
      dependencies={dependencies}
      labels={labels}
      onClose={onClose}
    />
  );
}

function OpenTaskDetailSheet({
  serverId,
  task,
  project,
  projectsById,
  tasks,
  dependencies,
  labels,
  onClose,
}: {
  serverId: string;
  task: Task;
  project: TaskProject | undefined;
  projectsById: ReadonlyMap<string, TaskProject>;
  tasks: readonly Task[];
  dependencies: readonly TaskDependencyEdge[];
  labels: readonly TaskLabel[];
  onClose: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const toast = useToast();
  const { setStatus, setPriority } = useTaskMutations(serverId);
  const { entries } = useBoardFeed({ serverId, projectId: task.projectId });
  const { post, isPosting } = useBoardFeedComposer({ serverId, projectId: task.projectId });
  const [draft, setDraft] = useState("");

  const { presets } = useTaskPresets(serverId);
  const { delegate, isDelegating } = useTaskDelegate(serverId);
  const blockers = useMemo(
    () => selectBlockers({ taskId: task.id, tasks, dependencies }),
    [dependencies, task.id, tasks],
  );
  const handleDelegate = useCallback(
    (presetId: string) => {
      void delegate({ taskId: task.id, presetId }).catch((error) => {
        toast.show(toErrorMessage(error));
      });
    },
    [delegate, task.id, toast],
  );

  const taskLabels = useMemo(() => resolveTaskLabels(task, labels), [task, labels]);
  const comments = useMemo(
    () => entries.filter((entry) => entry.taskId === task.id),
    [entries, task.id],
  );

  const handleSelectStatus = useCallback(
    (status: TaskStatus) => {
      void setStatus({ taskId: task.id, status }).catch((error) => {
        toast.show(toErrorMessage(error));
      });
    },
    [setStatus, task.id, toast],
  );

  const handleSelectPriority = useCallback(
    (priority: TaskPriority) => {
      void setPriority({ taskId: task.id, priority }).catch((error) => {
        toast.show(toErrorMessage(error));
      });
    },
    [setPriority, task.id, toast],
  );

  const handleOpenAgent = useCallback(
    (input: { workspaceId: string; agentId: string }) => {
      navigateToWorkspace({
        serverId,
        workspaceId: input.workspaceId,
        target: { kind: "agent", agentId: input.agentId },
      });
    },
    [serverId],
  );

  const handleSend = useCallback(() => {
    const body = draft.trim();
    if (body.length === 0 || isPosting) {
      return;
    }
    setDraft("");
    void post({ body, taskId: task.id }).catch((error) => {
      setDraft(body);
      toast.show(toErrorMessage(error));
    });
  }, [draft, isPosting, post, task.id, toast]);

  const header = useMemo(
    () => ({ title: formatTaskKey(project, task), subtitle: task.title }),
    [project, task],
  );

  return (
    <AdaptiveModalSheet header={header} visible onClose={onClose} testID="task-detail-sheet">
      <View style={styles.body}>
        <View style={styles.fieldRow}>
          <DropdownMenu>
            <DropdownTrigger testID="task-detail-status-trigger">
              <Text style={styles.fieldValue}>{t(TASK_STATUS_LABEL_KEYS[task.status])}</Text>
            </DropdownTrigger>
            <DropdownMenuContent align="start">
              {TASK_STATUSES.map((status) => (
                <StatusMenuItem
                  key={status}
                  status={status}
                  selected={status === task.status}
                  onSelect={handleSelectStatus}
                />
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <DropdownMenu>
            <DropdownTrigger testID="task-detail-priority-trigger">
              <Text style={styles.fieldValue}>
                {task.priority === "none"
                  ? t("tasks.detail.priorityNone")
                  : t(TASK_PRIORITY_LABEL_KEYS[task.priority])}
              </Text>
            </DropdownTrigger>
            <DropdownMenuContent align="start">
              {TASK_PRIORITIES.map((priority) => (
                <PriorityMenuItem
                  key={priority}
                  priority={priority}
                  selected={priority === task.priority}
                  onSelect={handleSelectPriority}
                />
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </View>

        {task.description.trim().length > 0 ? (
          <Text style={styles.description}>{task.description}</Text>
        ) : null}

        <TaskLabelChips labels={taskLabels} />

        {task.dueDate ? (
          <Text style={styles.dueDate}>{t("tasks.detail.due", { date: task.dueDate })}</Text>
        ) : null}

        {blockers.length > 0 ? (
          <View style={styles.section} testID="task-detail-blockers">
            <Text style={styles.sectionHeading}>{t("tasks.detail.blockedHeading")}</Text>
            {blockers.map((blocker) => (
              <Text key={blocker.id} style={styles.blocker}>
                {formatTaskKey(projectsById.get(blocker.projectId), blocker)} {blocker.title}
              </Text>
            ))}
          </View>
        ) : null}

        {presets.length > 0 ? (
          <View style={styles.section}>
            <Text style={styles.sectionHeading}>{t("tasks.detail.startHeading")}</Text>
            <View style={styles.presetRow}>
              {presets.map((preset) => (
                <PresetButton
                  key={preset.id}
                  preset={preset}
                  disabled={blockers.length > 0 || isDelegating}
                  onStart={handleDelegate}
                />
              ))}
            </View>
          </View>
        ) : null}

        {task.agents.length > 0 ? (
          <View style={styles.section}>
            <Text style={styles.sectionHeading}>{t("tasks.detail.agentsHeading")}</Text>
            {task.agents.map((link) => (
              <AgentRow
                key={link.agentId}
                serverId={serverId}
                workspaceId={link.workspaceId}
                agentId={link.agentId}
                onOpenAgent={handleOpenAgent}
              />
            ))}
          </View>
        ) : null}

        <View style={styles.section}>
          <Text style={styles.sectionHeading}>{t("tasks.detail.commentsHeading")}</Text>
          {comments.length === 0 ? (
            <Text style={styles.emptyComments}>{t("tasks.detail.commentsEmpty")}</Text>
          ) : (
            comments.map((entry) => <BoardFeedEntryRow key={entry.id} entry={entry} />)
          )}
        </View>

        <View style={styles.composer}>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            onSubmitEditing={handleSend}
            placeholder={t("tasks.detail.commentPlaceholder")}
            placeholderTextColor={styles.placeholder.color}
            style={styles.input}
            multiline
            testID="task-detail-comment-input"
          />
          <Button
            variant="ghost"
            size="sm"
            leftIcon={SendHorizontal}
            onPress={handleSend}
            disabled={draft.trim().length === 0 || isPosting}
            accessibilityLabel={t("tasks.detail.commentSend")}
            testID="task-detail-comment-send"
          />
        </View>
      </View>
    </AdaptiveModalSheet>
  );
}

/** One preset, one press: it starts an agent already attached to the card. */
function PresetButton({
  preset,
  disabled,
  onStart,
}: {
  preset: TaskPreset;
  disabled: boolean;
  onStart: (presetId: string) => void;
}): ReactElement {
  const handlePress = useCallback(() => onStart(preset.id), [onStart, preset.id]);
  return (
    <Button
      variant="outline"
      size="sm"
      onPress={handlePress}
      disabled={disabled}
      testID={`task-detail-preset-${preset.id}`}
    >
      {preset.name}
    </Button>
  );
}

function StatusMenuItem({
  status,
  selected,
  onSelect,
}: {
  status: TaskStatus;
  selected: boolean;
  onSelect: (status: TaskStatus) => void;
}): ReactElement {
  const { t } = useTranslation();
  const handleSelect = useCallback(() => onSelect(status), [onSelect, status]);
  return (
    <DropdownMenuItem
      selected={selected}
      testID={`task-detail-status-${status}`}
      onSelect={handleSelect}
    >
      {t(TASK_STATUS_LABEL_KEYS[status])}
    </DropdownMenuItem>
  );
}

function PriorityMenuItem({
  priority,
  selected,
  onSelect,
}: {
  priority: TaskPriority;
  selected: boolean;
  onSelect: (priority: TaskPriority) => void;
}): ReactElement {
  const { t } = useTranslation();
  const handleSelect = useCallback(() => onSelect(priority), [onSelect, priority]);
  return (
    <DropdownMenuItem
      selected={selected}
      testID={`task-detail-priority-${priority}`}
      onSelect={handleSelect}
    >
      {priority === "none" ? t("tasks.detail.priorityNone") : t(TASK_PRIORITY_LABEL_KEYS[priority])}
    </DropdownMenuItem>
  );
}

function AgentRow({
  serverId,
  workspaceId,
  agentId,
  onOpenAgent,
}: {
  serverId: string;
  workspaceId: string;
  agentId: string;
  onOpenAgent: (input: { workspaceId: string; agentId: string }) => void;
}): ReactElement {
  const workspace = useWorkspace(serverId, workspaceId);
  const label = workspace?.title ?? workspace?.name ?? workspaceId;
  const handlePress = useCallback(
    () => onOpenAgent({ workspaceId, agentId }),
    [agentId, onOpenAgent, workspaceId],
  );

  return (
    <Button
      variant="ghost"
      size="sm"
      onPress={handlePress}
      style={styles.agentRow}
      testID={`task-detail-agent-${agentId}`}
    >
      {label}
    </Button>
  );
}

const styles = StyleSheet.create((theme) => ({
  blocker: {
    color: theme.colors.statusWarning,
    fontSize: theme.fontSize.sm,
  },
  presetRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  body: {
    gap: theme.spacing[4],
    paddingHorizontal: theme.spacing[4],
    paddingTop: theme.spacing[2],
    paddingBottom: theme.spacing[4],
  },
  fieldRow: {
    flexDirection: "row",
    gap: theme.spacing[4],
  },
  fieldValue: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  description: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  dueDate: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  section: {
    gap: theme.spacing[2],
  },
  sectionHeading: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    textTransform: "uppercase",
  },
  agentRow: {
    alignItems: "flex-start",
  },
  emptyComments: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  composer: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: theme.spacing[2],
  },
  input: {
    flex: 1,
    maxHeight: 120,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface1,
  },
  placeholder: {
    color: theme.colors.foregroundMuted,
  },
}));
