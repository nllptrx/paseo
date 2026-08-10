import { useCallback, useMemo, useState, type ReactElement, type ReactNode } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight, SendHorizontal } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type {
  Task,
  TaskComment,
  TaskExecutionPolicy,
  TaskLabel,
  TaskPreset,
  TaskPriority,
  TaskProject,
  TaskStatus,
} from "@getpaseo/protocol/tasks/types";
import { resolveTaskExecutionPolicy } from "@getpaseo/protocol/tasks/types";
import type { Step, TaskWorkflow } from "@getpaseo/protocol/tasks/workflow";
import { TASK_STATUSES } from "@getpaseo/protocol/tasks/types";
import { AdaptiveModalSheet, AdaptiveTextInput } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { DropdownTrigger } from "@/components/ui/dropdown-trigger";
import { FormTextInput } from "@/components/ui/form-field";
import { Switch } from "@/components/ui/switch";
import { SettingsGroup } from "@/screens/settings/settings-group";
import { SettingsSection } from "@/screens/settings/settings-section";
import { settingsStyles } from "@/styles/settings";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { useToast } from "@/contexts/toast-context";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import {
  formatTaskKey,
  resolveTaskLabels,
  selectBlockers,
  type TaskDependencyEdge,
} from "@/tasks/task-views";
import {
  AGGREGATE_WORK_REFUSAL,
  applyReviewMode,
  canCreateSubtask,
  EMPTY_SUBTASK_DRAFT,
  formatReviewModeSummary,
  resolveReviewMode,
  REVIEW_MODE_LABELS,
  REVIEW_MODES,
  toSubtaskCreateInput,
  withSubtaskParallel,
  withSubtaskPreset,
  withSubtaskTitle,
  type ReviewMode,
  type SubtaskDraft,
} from "@/tasks/task-aggregate";
import { useTaskDelegate, useTaskPresets } from "@/tasks/use-task-delegate";
import {
  resolveStepState,
  useTaskStepActions,
  type TaskStepAction,
} from "@/tasks/use-task-workflow";
import { resolveStepAgentTarget } from "@/tasks/task-workflow-view";
import { useBoardFeed, useBoardFeedComposer } from "@/tasks/use-board-feed";
import {
  useTaskExecutionPolicySupported,
  useTaskMessagesSupported,
  useTaskMutations,
} from "@/tasks/use-tasks";
import { toErrorMessage } from "@/utils/error-messages";
import { BoardFeedEntryRow } from "./board-feed-entry";
import { activityFeedShowsHeader, groupActivityFeedEntries } from "./board-feed-entry.logic";
import { TaskExecutionStateDot } from "./task-execution-summary";
import {
  TASK_PRIORITY_LABEL_KEYS,
  TASK_STATUS_LABEL_KEYS,
  TaskLabelChips,
} from "./task-board-parts";
import {
  canStartTaskReview,
  groupTaskExecutionsByWorkspace,
  TASK_EXECUTION_STATE_LABELS,
  type TaskExecutionEntry,
  type TaskExecutionSummary,
  type TaskExecutionWorkspaceGroup,
} from "@/tasks/task-execution";
import { resolveProviderLabel } from "@/tasks/use-task-available-providers";

const TASK_PRIORITIES: readonly TaskPriority[] = ["none", "urgent", "high", "medium", "low"];

type TaskDetailTab = "execution" | "details" | "activity";

const ThemedChevronRight = withUnistyles(ChevronRight);
const ThemedChevronDown = withUnistyles(ChevronDown);

const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export interface TaskDetailSheetProps {
  serverId: string;
  taskId: string | null;
  tasks: readonly Task[];
  labels: readonly TaskLabel[];
  projectsById: ReadonlyMap<string, TaskProject>;
  dependencies: readonly TaskDependencyEdge[];
  workflows: readonly TaskWorkflow[];
  executionSummary?: TaskExecutionSummary | undefined;
  /** Every card's live execution, so a subtask row can show its own state
   * without the sheet refetching what the board already read. */
  executionByTaskId?: ReadonlyMap<string, TaskExecutionSummary> | undefined;
  /** Opens the workflow editor for this task; the board owns that sheet. */
  onEditWorkflow: (taskId: string, existingSteps?: readonly Step[]) => void;
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
  workflows,
  executionSummary,
  executionByTaskId,
  onEditWorkflow,
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
      workflow={workflows.find((entry) => entry.taskId === task.id) ?? null}
      executionSummary={executionSummary}
      executionByTaskId={executionByTaskId}
      onEditWorkflow={onEditWorkflow}
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
  workflow,
  executionSummary,
  executionByTaskId,
  onEditWorkflow,
  labels,
  onClose,
}: {
  serverId: string;
  task: Task;
  project: TaskProject | undefined;
  projectsById: ReadonlyMap<string, TaskProject>;
  tasks: readonly Task[];
  dependencies: readonly TaskDependencyEdge[];
  workflow: TaskWorkflow | null;
  executionSummary?: TaskExecutionSummary | undefined;
  executionByTaskId?: ReadonlyMap<string, TaskExecutionSummary> | undefined;
  onEditWorkflow: (taskId: string, existingSteps?: readonly Step[]) => void;
  labels: readonly TaskLabel[];
  onClose: () => void;
}): ReactElement {
  const toast = useToast();
  const {
    setStatus,
    setPriority,
    reviewTask,
    startReview,
    updateTask,
    createTask,
    isReviewing,
    isBusy,
  } = useTaskMutations(serverId);
  const { entries } = useBoardFeed({ serverId, projectId: task.projectId });
  const { post, sendMessage, isPosting } = useBoardFeedComposer({
    serverId,
    projectId: task.projectId,
  });
  const supportsMessages = useTaskMessagesSupported(serverId);
  const [activeTab, setActiveTab] = useState<TaskDetailTab>("execution");
  const [noteDraft, setNoteDraft] = useState("");
  const [reviewFeedback, setReviewFeedback] = useState("");
  const [titleDraft, setTitleDraft] = useState(task.title);
  const [descriptionDraft, setDescriptionDraft] = useState(task.description);
  const [subtaskDraft, setSubtaskDraft] = useState<SubtaskDraft>(EMPTY_SUBTASK_DRAFT);
  const [noteResetKey, setNoteResetKey] = useState(0);
  const [subtaskResetKey, setSubtaskResetKey] = useState(0);
  const executionGroups = useMemo(
    () => groupTaskExecutionsByWorkspace(executionSummary),
    [executionSummary],
  );
  const canArmReview = canStartTaskReview({
    status: task.status,
    entries: executionSummary?.entries ?? [],
  });
  const handleStartReview = useCallback(() => {
    void startReview(task.id).catch((startError) => toast.show(toErrorMessage(startError)));
  }, [startReview, task.id, toast]);

  const { presets } = useTaskPresets(serverId);
  const { delegate, isDelegating } = useTaskDelegate(serverId);
  const blockers = useMemo(
    () => selectBlockers({ taskId: task.id, tasks, dependencies }),
    [dependencies, task.id, tasks],
  );
  const parent = task.parentTaskId
    ? tasks.find((candidate) => candidate.id === task.parentTaskId)
    : undefined;
  const subtasks = useMemo(
    () => tasks.filter((candidate) => candidate.parentTaskId === task.id),
    [task.id, tasks],
  );
  const dependenciesForTask = useMemo(
    () =>
      dependencies
        .filter((edge) => edge.taskId === task.id)
        .map((edge) => tasks.find((candidate) => candidate.id === edge.dependsOnTaskId))
        .filter((candidate): candidate is Task => Boolean(candidate)),
    [dependencies, task.id, tasks],
  );
  // Subtasks have a section of their own: they are worked, reviewed and started
  // from here, which a one-line relationship row cannot carry.
  const relationships = useMemo<readonly { label: string; task: Task }[]>(
    () => [
      ...(parent ? [{ label: "Parent", task: parent }] : []),
      ...dependenciesForTask.map((dependency) => ({ label: "Waits for", task: dependency })),
    ],
    [dependenciesForTask, parent],
  );
  const isAggregate = subtasks.length > 0;
  // The verdict belongs where the change is read, not only in the card's menu:
  // someone who opened the task to judge it should not have to close it again to
  // say what they decided. A subtask is the same write on another card, so the
  // parent's sheet can settle a child without opening it.
  const submitReview = useCallback(
    (input: {
      taskId: string;
      verdict: "approve" | "reject";
      feedback?: string;
      subject: string;
    }) => {
      void reviewTask({
        taskId: input.taskId,
        verdict: input.verdict,
        ...(input.feedback ? { feedback: input.feedback } : {}),
      })
        .then((reviewedTask) => {
          if (input.verdict === "reject" && reviewedTask.status === "in_review") {
            toast.show(`The ${input.subject} remains in Review; no correction round was started.`);
          }
          return reviewedTask;
        })
        .catch((error) => {
          toast.show(toErrorMessage(error));
        });
    },
    [reviewTask, toast],
  );
  const handleApprove = useCallback(
    () => submitReview({ taskId: task.id, verdict: "approve", subject: "task" }),
    [submitReview, task.id],
  );
  const handleReject = useCallback(
    () =>
      submitReview({
        taskId: task.id,
        verdict: "reject",
        feedback: reviewFeedback.trim() || undefined,
        subject: "task",
      }),
    [reviewFeedback, submitReview, task.id],
  );
  const handleReviewSubtask = useCallback(
    (input: { taskId: string; verdict: "approve" | "reject"; feedback?: string }) =>
      submitReview({ ...input, subject: "subtask" }),
    [submitReview],
  );

  const handleDelegate = useCallback(
    (presetId: string) => {
      void delegate({ taskId: task.id, presetId }).catch((error) => {
        toast.show(toErrorMessage(error));
      });
    },
    [delegate, task.id, toast],
  );

  const { act, isActing } = useTaskStepActions(serverId);
  const handleStepAction = useCallback(
    (stepId: string, action: TaskStepAction) => {
      void act({ taskId: task.id, stepId, action }).catch((error) => {
        toast.show(toErrorMessage(error));
      });
    },
    [act, task.id, toast],
  );
  const handleEditWorkflow = useCallback(
    () => onEditWorkflow(task.id, workflow?.steps),
    [onEditWorkflow, task.id, workflow?.steps],
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

  const saveBrief = useCallback(() => {
    const title = titleDraft.trim();
    if (!title || (title === task.title && descriptionDraft === task.description)) {
      return;
    }
    void updateTask({ taskId: task.id, title, description: descriptionDraft }).catch((error) => {
      toast.show(toErrorMessage(error));
    });
  }, [descriptionDraft, task.description, task.id, task.title, titleDraft, toast, updateTask]);

  const createSubtask = useCallback(() => {
    const input = toSubtaskCreateInput(subtaskDraft, task);
    if (!input) {
      return;
    }
    const submitted = subtaskDraft;
    setSubtaskDraft(withSubtaskTitle(submitted, ""));
    setSubtaskResetKey((current) => current + 1);
    void createTask(input).catch((error) => {
      setSubtaskDraft(submitted);
      setSubtaskResetKey((current) => current + 1);
      toast.show(toErrorMessage(error));
    });
  }, [createTask, subtaskDraft, task, toast]);

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

  const submitNote = useCallback(() => {
    const body = noteDraft.trim();
    if (body.length === 0 || isPosting) {
      return;
    }
    setNoteDraft("");
    setNoteResetKey((current) => current + 1);
    void post({ body, taskId: task.id }).catch((error) => {
      setNoteDraft(body);
      setNoteResetKey((current) => current + 1);
      toast.show(toErrorMessage(error));
    });
  }, [isPosting, noteDraft, post, task.id, toast]);

  const taskKey = formatTaskKey(project, task);
  const header = useMemo(
    () => ({
      title: task.title,
      titleContent: (
        <AdaptiveTextInput
          initialValue={task.title}
          resetKey={task.title}
          onChangeText={setTitleDraft}
          onBlur={saveBrief}
          onEndEditing={saveBrief}
          placeholder="What needs to be done?"
          style={styles.headerTitleInput}
          testID="task-detail-title-input"
        />
      ),
      leading: <Text style={styles.taskKey}>{taskKey}</Text>,
      actions: (
        <TaskStartControl
          presets={presets}
          isAggregate={isAggregate}
          disabled={blockers.length > 0 || isDelegating}
          onStart={handleDelegate}
        />
      ),
      after: (
        <TaskDetailNavigation
          task={task}
          labels={taskLabels}
          activeTab={activeTab}
          onSelectTab={setActiveTab}
          onSelectStatus={handleSelectStatus}
          onSelectPriority={handleSelectPriority}
        />
      ),
    }),
    [
      activeTab,
      blockers.length,
      handleDelegate,
      handleSelectPriority,
      handleSelectStatus,
      isAggregate,
      isDelegating,
      presets,
      saveBrief,
      task,
      taskKey,
      taskLabels,
    ],
  );
  const footer = useMemo(
    () => (
      <TaskUnifiedComposer
        task={task}
        supportsMessages={supportsMessages}
        noteDraft={noteDraft}
        noteResetKey={noteResetKey}
        isPosting={isPosting}
        onNoteChange={setNoteDraft}
        onSubmitNote={submitNote}
        sendMessage={sendMessage}
      />
    ),
    [isPosting, noteDraft, noteResetKey, sendMessage, submitNote, supportsMessages, task],
  );

  return (
    <AdaptiveModalSheet
      header={header}
      visible
      onClose={onClose}
      desktopMaxWidth={720}
      testID="task-detail-sheet"
      footer={footer}
      footerContainerStyle={styles.unifiedComposerFooter}
    >
      {activeTab === "execution" ? (
        <View style={styles.tabContent} testID="task-detail-execution-tab">
          {task.status === "in_review" || blockers.length > 0 ? (
            <TaskDetailGroup title="Needs attention" testID="task-detail-attention">
              {task.status === "in_review" ? (
                <TaskReviewSection
                  iteration={task.reviewIteration}
                  canStartReview={canArmReview}
                  isReviewing={isReviewing}
                  onFeedbackChange={setReviewFeedback}
                  onApprove={handleApprove}
                  onReject={handleReject}
                  onStartReview={handleStartReview}
                />
              ) : null}
              {blockers.length > 0 ? (
                <TaskBlockersSection blockers={blockers} projectsById={projectsById} />
              ) : null}
            </TaskDetailGroup>
          ) : null}
          <TaskPlanSection
            workflow={workflow}
            isAggregate={isAggregate}
            isActing={isActing}
            onEdit={handleEditWorkflow}
            onAct={handleStepAction}
            onOpenAgent={handleOpenAgent}
          />
          <TaskAgentsSection groups={executionGroups} onOpenAgent={handleOpenAgent} />
          {subtasks.length > 0 || isAggregate ? (
            <TaskDetailGroup title="Subtasks" testID="task-detail-breakdown-group">
              <TaskSubtasksSection
                subtasks={subtasks}
                projectsById={projectsById}
                presets={presets}
                draft={subtaskDraft}
                draftResetKey={subtaskResetKey}
                executionByTaskId={executionByTaskId}
                isBusy={isBusy}
                isReviewing={isReviewing}
                onDraftChange={setSubtaskDraft}
                onCreate={createSubtask}
                onReview={handleReviewSubtask}
                onOpenAgent={handleOpenAgent}
              />
            </TaskDetailGroup>
          ) : null}
          <TaskAutomationDeliverySection
            serverId={serverId}
            task={task}
            project={project}
            presets={presets}
            hasSubtasks={isAggregate}
          />
        </View>
      ) : null}

      {activeTab === "details" ? (
        <View style={styles.tabContent} testID="task-detail-details-tab">
          <TaskOverview task={task} onDescriptionChange={setDescriptionDraft} onSave={saveBrief} />
          <TaskDetailGroup title="Breakdown" testID="task-detail-details-group">
            <TaskSubtasksSection
              subtasks={subtasks}
              projectsById={projectsById}
              presets={presets}
              draft={subtaskDraft}
              draftResetKey={subtaskResetKey}
              executionByTaskId={executionByTaskId}
              isBusy={isBusy}
              isReviewing={isReviewing}
              onDraftChange={setSubtaskDraft}
              onCreate={createSubtask}
              onReview={handleReviewSubtask}
              onOpenAgent={handleOpenAgent}
            />
            <TaskRelationshipsSection relationships={relationships} projectsById={projectsById} />
            <TaskAttachmentsSection task={task} />
          </TaskDetailGroup>
        </View>
      ) : null}

      {activeTab === "activity" ? (
        <View style={styles.tabContent} testID="task-detail-activity-tab">
          <TaskUpdatesSection comments={comments} serverId={serverId} />
        </View>
      ) : null}
    </AdaptiveModalSheet>
  );
}

function TaskStartControl({
  presets,
  isAggregate,
  disabled,
  onStart,
}: {
  presets: readonly TaskPreset[];
  isAggregate: boolean;
  disabled: boolean;
  onStart: (presetId: string) => void;
}): ReactElement | null {
  const presetId = presets.length === 1 ? presets[0]?.id : undefined;
  const handleSinglePreset = useCallback(() => {
    if (presetId) onStart(presetId);
  }, [onStart, presetId]);
  if (presets.length === 0 || isAggregate) return null;
  if (presets.length === 1) {
    const preset = presets[0];
    return (
      <Button
        variant="default"
        size="sm"
        disabled={disabled}
        onPress={handleSinglePreset}
        testID={`task-detail-preset-${preset.id}`}
      >
        Start work
      </Button>
    );
  }
  return (
    <DropdownMenu>
      <DropdownTrigger
        style={styles.startWorkTrigger}
        disabled={disabled}
        testID="task-detail-start-work"
      >
        <Text style={styles.startWorkLabel}>Start work</Text>
      </DropdownTrigger>
      <DropdownMenuContent align="end">
        {presets.map((preset) => (
          <TaskStartPresetItem key={preset.id} preset={preset} onStart={onStart} />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function TaskStartPresetItem({
  preset,
  onStart,
}: {
  preset: TaskPreset;
  onStart: (presetId: string) => void;
}): ReactElement {
  const handleSelect = useCallback(() => onStart(preset.id), [onStart, preset.id]);
  return (
    <DropdownMenuItem onSelect={handleSelect} testID={`task-detail-preset-${preset.id}`}>
      {preset.name}
    </DropdownMenuItem>
  );
}

function TaskDetailNavigation({
  task,
  labels,
  activeTab,
  onSelectTab,
  onSelectStatus,
  onSelectPriority,
}: {
  task: Task;
  labels: readonly TaskLabel[];
  activeTab: TaskDetailTab;
  onSelectTab: (tab: TaskDetailTab) => void;
  onSelectStatus: (status: TaskStatus) => void;
  onSelectPriority: (priority: TaskPriority) => void;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.propertyRow}
        style={styles.propertyScroller}
      >
        <TaskProperty label="Status">
          <DropdownMenu>
            <DropdownTrigger testID="task-detail-status-trigger">
              <Text style={styles.propertyValue}>{t(TASK_STATUS_LABEL_KEYS[task.status])}</Text>
            </DropdownTrigger>
            <DropdownMenuContent align="start">
              {TASK_STATUSES.map((status) => (
                <StatusMenuItem
                  key={status}
                  status={status}
                  selected={status === task.status}
                  onSelect={onSelectStatus}
                />
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </TaskProperty>
        <TaskProperty label="Priority">
          <DropdownMenu>
            <DropdownTrigger testID="task-detail-priority-trigger">
              <Text style={styles.propertyValue}>
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
                  onSelect={onSelectPriority}
                />
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </TaskProperty>
        <TaskProperty label="Labels">
          {labels.length > 0 ? (
            <TaskLabelChips labels={labels} />
          ) : (
            <Text style={styles.propertyEmpty}>None</Text>
          )}
        </TaskProperty>
        {task.dueDate ? (
          <TaskProperty label="Due">
            <Text style={styles.propertyValue}>{task.dueDate}</Text>
          </TaskProperty>
        ) : null}
      </ScrollView>
      <View style={styles.tabBar} accessibilityRole="tablist">
        <TaskDetailTabButton
          tab="execution"
          label="Execution"
          activeTab={activeTab}
          onSelect={onSelectTab}
        />
        <TaskDetailTabButton
          tab="details"
          label="Details"
          activeTab={activeTab}
          onSelect={onSelectTab}
        />
        <TaskDetailTabButton
          tab="activity"
          label="Activity"
          activeTab={activeTab}
          onSelect={onSelectTab}
        />
      </View>
    </View>
  );
}

function TaskProperty({ label, children }: { label: string; children: ReactNode }): ReactElement {
  return (
    <View style={styles.property}>
      <Text style={styles.propertyLabel}>{label}</Text>
      {children}
    </View>
  );
}

function TaskDetailTabButton({
  tab,
  label,
  activeTab,
  onSelect,
}: {
  tab: TaskDetailTab;
  label: string;
  activeTab: TaskDetailTab;
  onSelect: (tab: TaskDetailTab) => void;
}): ReactElement {
  const active = tab === activeTab;
  const handlePress = useCallback(() => onSelect(tab), [onSelect, tab]);
  const accessibilityState = useMemo(() => ({ selected: active }), [active]);
  return (
    <Pressable
      onPress={handlePress}
      accessibilityRole="tab"
      accessibilityState={accessibilityState}
      style={[styles.tab, active ? styles.tabActive : null]}
      testID={`task-detail-tab-${tab}`}
    >
      <Text style={[styles.tabLabel, active ? styles.tabLabelActive : null]}>{label}</Text>
    </Pressable>
  );
}

type TaskComposerMode = "instruction" | "note";

function TaskUnifiedComposer({
  task,
  supportsMessages,
  noteDraft,
  noteResetKey,
  isPosting,
  onNoteChange,
  onSubmitNote,
  sendMessage,
}: {
  task: Task;
  supportsMessages: boolean;
  noteDraft: string;
  noteResetKey: number;
  isPosting: boolean;
  onNoteChange: (note: string) => void;
  onSubmitNote: () => void;
  sendMessage: (input: {
    body: string;
    taskId: string;
    recipientAgentIds: string[];
  }) => Promise<void>;
}): ReactElement {
  const toast = useToast();
  const canInstruct = supportsMessages && task.agents.length > 0;
  const [mode, setMode] = useState<TaskComposerMode>(canInstruct ? "instruction" : "note");
  const [instructionDraft, setInstructionDraft] = useState("");
  const [instructionResetKey, setInstructionResetKey] = useState(0);
  const useInstruction = useCallback(() => setMode("instruction"), []);
  const useNote = useCallback(() => setMode("note"), []);
  const submitInstruction = useCallback(() => {
    const body = instructionDraft.trim();
    if (!body || !canInstruct || isPosting) return;
    setInstructionDraft("");
    setInstructionResetKey((current) => current + 1);
    void sendMessage({
      body,
      taskId: task.id,
      recipientAgentIds: task.agents.map((agent) => agent.agentId),
    }).catch((error) => {
      setInstructionDraft(body);
      setInstructionResetKey((current) => current + 1);
      toast.show(toErrorMessage(error));
    });
  }, [canInstruct, instructionDraft, isPosting, sendMessage, task.agents, task.id, toast]);
  const submit = mode === "instruction" ? submitInstruction : onSubmitNote;
  const draft = mode === "instruction" ? instructionDraft : noteDraft;
  const resetKey = mode === "instruction" ? instructionResetKey : noteResetKey;
  const onChange = mode === "instruction" ? setInstructionDraft : onNoteChange;

  return (
    <View style={styles.unifiedComposer} testID="task-detail-unified-composer">
      <View style={styles.composerModeRow}>
        <Button
          variant={mode === "instruction" ? "secondary" : "ghost"}
          size="xs"
          onPress={useInstruction}
          disabled={!canInstruct}
          testID="task-detail-composer-instruction"
        >
          Agent instruction
        </Button>
        <Button
          variant={mode === "note" ? "secondary" : "ghost"}
          size="xs"
          onPress={useNote}
          testID="task-detail-composer-note"
        >
          Internal note
        </Button>
      </View>
      <View style={styles.composerInputRow}>
        <View style={styles.fieldFill}>
          <FormTextInput
            initialValue={draft}
            resetKey={`${mode}-${resetKey}`}
            onChangeText={onChange}
            onSubmitEditing={submit}
            placeholder={
              mode === "instruction" ? "Instruct the agent..." : "Write an internal note..."
            }
            multiline
            testID={`task-detail-${mode}-input`}
          />
        </View>
        <Button
          variant="secondary"
          size="sm"
          leftIcon={SendHorizontal}
          onPress={submit}
          disabled={!draft.trim() || isPosting || (mode === "instruction" && !canInstruct)}
          testID={`task-detail-${mode}-send`}
        >
          Send
        </Button>
      </View>
    </View>
  );
}

function TaskDetailGroup({
  title,
  testID,
  children,
}: {
  title: string;
  testID: string;
  children: ReactNode;
}): ReactElement {
  return (
    <SettingsGroup title={title} testID={testID}>
      <View style={styles.groupContent}>{children}</View>
    </SettingsGroup>
  );
}

function TaskOverview({
  task,
  onDescriptionChange,
  onSave,
}: {
  task: Task;
  onDescriptionChange: (description: string) => void;
  onSave: () => void;
}): ReactElement {
  return (
    <SettingsGroup title="Task description" testID="task-detail-brief">
      <AdaptiveTextInput
        initialValue={task.description}
        resetKey={task.description}
        onChangeText={onDescriptionChange}
        onBlur={onSave}
        onEndEditing={onSave}
        placeholder="Describe the outcome, context, and constraints for the agent"
        style={styles.detailsDescriptionInput}
        multiline
        testID="task-detail-description-input"
      />
    </SettingsGroup>
  );
}

function TaskReviewSection({
  iteration,
  canStartReview,
  isReviewing,
  onFeedbackChange,
  onApprove,
  onReject,
  onStartReview,
}: {
  iteration: number | undefined;
  canStartReview: boolean;
  isReviewing: boolean;
  onFeedbackChange: (feedback: string) => void;
  onApprove: () => void;
  onReject: () => void;
  onStartReview: () => void;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <SettingsSection title={t("tasks.detail.reviewerHeading")} flush testID="task-detail-review">
      <FormTextInput
        onChangeText={onFeedbackChange}
        placeholder="Correction feedback (sent to the worker on rejection)"
        multiline
        editable={!isReviewing}
        testID="task-detail-review-feedback"
      />
      {iteration ? <Text style={settingsStyles.rowHint}>Correction round {iteration}</Text> : null}
      <View style={styles.actionRow}>
        <Button
          variant="default"
          size="sm"
          onPress={onApprove}
          loading={isReviewing}
          testID="task-detail-approve"
        >
          {t("tasks.board.approve")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onPress={onReject}
          disabled={isReviewing}
          testID="task-detail-reject"
        >
          {t("tasks.board.reject")}
        </Button>
        {canStartReview ? (
          <Button
            variant="ghost"
            size="sm"
            onPress={onStartReview}
            disabled={isReviewing}
            testID="task-detail-start-review"
          >
            {t("tasks.board.startReview")}
          </Button>
        ) : null}
      </View>
    </SettingsSection>
  );
}

function TaskBlockersSection({
  blockers,
  projectsById,
}: {
  blockers: readonly Task[];
  projectsById: ReadonlyMap<string, TaskProject>;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <SettingsSection title={t("tasks.detail.blockedHeading")} flush testID="task-detail-blockers">
      <View style={settingsStyles.card}>
        {blockers.map((blocker, index) => (
          <View
            key={blocker.id}
            style={[settingsStyles.row, index > 0 ? settingsStyles.rowBorder : null]}
          >
            <View style={settingsStyles.rowContent}>
              <Text style={styles.blocker} numberOfLines={1}>
                {blocker.title}
              </Text>
              <Text style={settingsStyles.rowHint}>
                {formatTaskKey(projectsById.get(blocker.projectId), blocker)}
              </Text>
            </View>
          </View>
        ))}
      </View>
    </SettingsSection>
  );
}

function TaskRelationshipsSection({
  relationships,
  projectsById,
}: {
  relationships: readonly { label: string; task: Task }[];
  projectsById: ReadonlyMap<string, TaskProject>;
}): ReactElement | null {
  if (relationships.length === 0) return null;
  return (
    <SettingsSection title="Relationships" flush testID="task-detail-relationships">
      <View style={settingsStyles.card}>
        {relationships.map((relationship, index) => (
          <TaskRelationshipRow
            key={`${relationship.label}-${relationship.task.id}`}
            label={relationship.label}
            task={relationship.task}
            project={projectsById.get(relationship.task.projectId)}
            withBorder={index > 0}
          />
        ))}
      </View>
    </SettingsSection>
  );
}

function TaskAttachmentsSection({ task }: { task: Task }): ReactElement | null {
  if (task.attachments.length === 0) return null;
  return (
    <SettingsSection title="Attachments" flush testID="task-detail-attachments">
      <View style={settingsStyles.card}>
        {task.attachments.map((attachment, index) => (
          <View
            key={attachment.id}
            style={[settingsStyles.row, index > 0 ? settingsStyles.rowBorder : null]}
          >
            <View style={settingsStyles.rowContent}>
              <Text style={settingsStyles.rowTitle} numberOfLines={1}>
                {attachment.fileName}
              </Text>
            </View>
          </View>
        ))}
      </View>
    </SettingsSection>
  );
}

function TaskAgentsSection({
  groups,
  onOpenAgent,
}: {
  groups: readonly TaskExecutionWorkspaceGroup[];
  onOpenAgent: (input: { workspaceId: string; agentId: string }) => void;
}): ReactElement | null {
  const { t } = useTranslation();
  if (groups.length === 0) return null;
  return (
    <SettingsSection title={t("tasks.detail.agentsHeading")} flush>
      <View style={styles.executionGroups}>
        {groups.map((group) => (
          <WorkspaceExecutionGroupCard
            key={group.workspaceId}
            group={group}
            onOpenAgent={onOpenAgent}
          />
        ))}
      </View>
    </SettingsSection>
  );
}

function TaskUpdatesSection({
  comments,
  serverId,
}: {
  comments: readonly TaskComment[];
  serverId: string;
}): ReactElement {
  const groups = useMemo(() => groupActivityFeedEntries(comments), [comments]);
  if (comments.length === 0) {
    return <Text style={styles.activityEmpty}>No activity yet</Text>;
  }
  return (
    <View testID="task-detail-activity-feed">
      {groups.map(({ entry, repeatCount, firstCreatedAt }, index) => (
        <BoardFeedEntryRow
          key={entry.id}
          entry={entry}
          serverId={serverId}
          appearance="activity"
          collapsible
          activityRepeatCount={repeatCount}
          activityFirstCreatedAt={firstCreatedAt}
          activityShowHeader={activityFeedShowsHeader(groups[index - 1]?.entry, entry)}
          activityIsFirst={index === 0}
          activityIsLast={index === groups.length - 1}
        />
      ))}
    </View>
  );
}

/**
 * The task's saved plan. On an aggregate the plan is refused rather than hidden:
 * the steps of one authored before the subtasks existed stay readable, with
 * their run history, but nothing new can be authored on a card that holds no
 * workers.
 */
function TaskPlanSection({
  workflow,
  isAggregate,
  isActing,
  onEdit,
  onAct,
  onOpenAgent,
}: {
  workflow: TaskWorkflow | null;
  isAggregate: boolean;
  isActing: boolean;
  onEdit: () => void;
  onAct: (stepId: string, action: TaskStepAction) => void;
  onOpenAgent: (input: { workspaceId: string; agentId: string }) => void;
}): ReactElement {
  const steps = workflow?.steps ?? [];
  const trailing = useMemo(
    () => (
      <Button
        variant="ghost"
        size="sm"
        onPress={onEdit}
        disabled={isAggregate}
        testID="task-detail-workflow-edit"
      >
        {workflow ? "Edit" : "Add plan"}
      </Button>
    ),
    [isAggregate, onEdit, workflow],
  );
  return (
    <SettingsSection title="Agent plan" flush testID="task-detail-workflow" trailing={trailing}>
      <Text style={settingsStyles.rowHint}>
        {isAggregate
          ? AGGREGATE_WORK_REFUSAL
          : "The task brief is sent with every step. Add instructions only where they differ."}
      </Text>
      {steps.length > 0 ? (
        <View style={styles.planSteps}>
          {steps.map((step, index) => (
            <WorkflowStepRow
              key={step.id}
              step={step}
              index={index}
              disabled={isActing}
              onAct={onAct}
              onOpenAgent={onOpenAgent}
            />
          ))}
        </View>
      ) : null}
      {steps.length > 0 || isAggregate ? null : (
        <Text style={styles.emptyComments}>
          No saved plan. Start from a preset, or add a multi-step agent plan.
        </Text>
      )}
    </SettingsSection>
  );
}

/**
 * Where an aggregate's work is created, watched and settled. Creation carries
 * the two choices that cannot be added later without rewriting stored edges:
 * which preset runs the subtask, and whether it waits for its sibling.
 */
function TaskSubtasksSection({
  subtasks,
  projectsById,
  presets,
  draft,
  draftResetKey,
  executionByTaskId,
  isBusy,
  isReviewing,
  onDraftChange,
  onCreate,
  onReview,
  onOpenAgent,
}: {
  subtasks: readonly Task[];
  projectsById: ReadonlyMap<string, TaskProject>;
  presets: readonly TaskPreset[];
  draft: SubtaskDraft;
  draftResetKey: number;
  executionByTaskId: ReadonlyMap<string, TaskExecutionSummary> | undefined;
  isBusy: boolean;
  isReviewing: boolean;
  onDraftChange: (draft: SubtaskDraft) => void;
  onCreate: () => void;
  onReview: (input: { taskId: string; verdict: "approve" | "reject"; feedback?: string }) => void;
  onOpenAgent: (input: { workspaceId: string; agentId: string }) => void;
}): ReactElement {
  const handleTitle = useCallback(
    (title: string) => onDraftChange(withSubtaskTitle(draft, title)),
    [draft, onDraftChange],
  );
  const handlePreset = useCallback(
    (presetId: string) =>
      onDraftChange(withSubtaskPreset(draft, presetId === "none" ? "" : presetId)),
    [draft, onDraftChange],
  );
  const handleParallel = useCallback(
    (parallel: boolean) => onDraftChange(withSubtaskParallel(draft, parallel)),
    [draft, onDraftChange],
  );
  const presetLabel = draft.presetId
    ? (presets.find((preset) => preset.id === draft.presetId)?.name ?? "Missing preset")
    : "Start by hand";

  return (
    <SettingsSection title="Subtasks" flush testID="task-detail-subtasks">
      {subtasks.length > 0 ? (
        <View style={styles.executionGroups}>
          {subtasks.map((subtask) => (
            <SubtaskRow
              key={subtask.id}
              subtask={subtask}
              project={projectsById.get(subtask.projectId)}
              execution={executionByTaskId?.get(subtask.id)}
              isReviewing={isReviewing}
              onReview={onReview}
              onOpenAgent={onOpenAgent}
            />
          ))}
        </View>
      ) : null}
      <View style={settingsStyles.card}>
        <View style={settingsStyles.row}>
          <AdaptiveTextInput
            initialValue={draft.title}
            resetKey={draftResetKey}
            onChangeText={handleTitle}
            onSubmitEditing={onCreate}
            placeholder="Add a subtask"
            style={styles.inlineInput}
            testID="task-detail-subtask-input"
          />
          <Button
            variant="ghost"
            size="sm"
            onPress={onCreate}
            disabled={!canCreateSubtask(draft) || isBusy}
            testID="task-detail-subtask-add"
          >
            Add
          </Button>
        </View>
        {presets.length > 0 ? (
          <PolicySelect
            label="Runs as"
            value={presetLabel}
            options={[
              { id: "none", label: "Start by hand" },
              ...presets.map((preset) => ({ id: preset.id, label: preset.name })),
            ]}
            selected={draft.presetId || "none"}
            onSelect={handlePreset}
            testID="task-detail-subtask-preset"
          />
        ) : null}
        <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>Run beside the previous subtask</Text>
            <Text style={settingsStyles.rowHint}>
              {draft.parallel
                ? "Ready as soon as it is created."
                : "Waits for the subtask created before it."}
            </Text>
          </View>
          <Switch
            value={draft.parallel}
            onValueChange={handleParallel}
            accessibilityLabel="Run beside the previous subtask"
            testID="task-detail-subtask-parallel"
          />
        </View>
      </View>
    </SettingsSection>
  );
}

/** One subtask: its own status and live state as a row, its agents and verdict
 * one press deeper — the parent's sheet is where a chain is watched. */
function SubtaskRow({
  subtask,
  project,
  execution,
  isReviewing,
  onReview,
  onOpenAgent,
}: {
  subtask: Task;
  project: TaskProject | undefined;
  execution: TaskExecutionSummary | undefined;
  isReviewing: boolean;
  onReview: (input: { taskId: string; verdict: "approve" | "reject"; feedback?: string }) => void;
  onOpenAgent: (input: { workspaceId: string; agentId: string }) => void;
}): ReactElement {
  const { t } = useTranslation();
  const [isExpanded, setIsExpanded] = useState(false);
  const [feedback, setFeedback] = useState("");
  const toggle = useCallback(() => setIsExpanded((current) => !current), []);
  const approve = useCallback(
    () => onReview({ taskId: subtask.id, verdict: "approve" }),
    [onReview, subtask.id],
  );
  const reject = useCallback(
    () =>
      onReview({ taskId: subtask.id, verdict: "reject", feedback: feedback.trim() || undefined }),
    [feedback, onReview, subtask.id],
  );
  const leadEntry = execution?.entries[0];

  return (
    <View style={settingsStyles.card} testID={`task-detail-subtask-${subtask.id}`}>
      <Pressable
        onPress={toggle}
        accessibilityRole="button"
        accessibilityLabel={`${isExpanded ? "Collapse" : "Expand"} ${subtask.title}`}
        style={settingsStyles.row}
        testID={`task-detail-subtask-toggle-${subtask.id}`}
      >
        <View style={styles.agentIdentity}>
          {leadEntry ? <TaskExecutionStateDot state={leadEntry.state} /> : null}
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle} numberOfLines={1}>
              {subtask.title}
            </Text>
            <Text style={settingsStyles.rowHint} numberOfLines={1}>
              {formatSubtaskDetail({
                subtask,
                project,
                execution,
                statusLabel: t(TASK_STATUS_LABEL_KEYS[subtask.status]),
              })}
            </Text>
          </View>
        </View>
        <ThemedChevronRight size={ICON_SIZE.sm} uniProps={mutedIconMapping} />
      </Pressable>
      {isExpanded ? (
        <>
          {execution?.entries.map((entry) => (
            <AgentRow key={entry.agentId} entry={entry} onOpenAgent={onOpenAgent} />
          ))}
          {subtask.status === "in_review" ? (
            <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
              <View style={settingsStyles.rowContent}>
                <FormTextInput
                  onChangeText={setFeedback}
                  placeholder="Correction feedback (sent to the worker on rejection)"
                  multiline
                  editable={!isReviewing}
                  testID={`task-detail-subtask-feedback-${subtask.id}`}
                />
                <View style={styles.actionRow}>
                  <Button
                    variant="default"
                    size="sm"
                    onPress={approve}
                    loading={isReviewing}
                    testID={`task-detail-subtask-approve-${subtask.id}`}
                  >
                    {t("tasks.board.approve")}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onPress={reject}
                    disabled={isReviewing}
                    testID={`task-detail-subtask-reject-${subtask.id}`}
                  >
                    {t("tasks.board.reject")}
                  </Button>
                </View>
              </View>
            </View>
          ) : null}
        </>
      ) : null}
    </View>
  );
}

function formatSubtaskDetail(input: {
  subtask: Task;
  project: TaskProject | undefined;
  execution: TaskExecutionSummary | undefined;
  statusLabel: string;
}): string {
  const details = [formatTaskKey(input.project, input.subtask), input.statusLabel];
  const entry = input.execution?.entries[0];
  if (entry) {
    details.push(TASK_EXECUTION_STATE_LABELS[entry.state]);
  }
  if (input.subtask.executionSpec?.trigger === "on_unblocked") {
    details.push("starts when unblocked");
  }
  return details.join(" · ");
}

function TaskAutomationDeliverySection({
  serverId,
  task,
  project,
  presets,
  hasSubtasks,
}: {
  serverId: string;
  task: Task;
  project: TaskProject | undefined;
  presets: readonly TaskPreset[];
  hasSubtasks: boolean;
}): ReactElement {
  const [expanded, setExpanded] = useState(false);
  const toggleExpanded = useCallback(() => setExpanded((current) => !current), []);
  const accessibilityState = useMemo(() => ({ expanded }), [expanded]);
  const effectivePolicy = resolveTaskExecutionPolicy(project?.board, task.executionPolicy);
  const reviewMode = hasSubtasks ? resolveReviewMode(task.executionPolicy ?? {}) : null;
  const summary = task.integration?.branch
    ? task.integration.branch
    : formatAutomationSummary(effectivePolicy, presets, reviewMode);
  return (
    <View style={styles.automationDelivery} testID="task-detail-automation-delivery">
      <Pressable
        onPress={toggleExpanded}
        accessibilityRole="button"
        accessibilityState={accessibilityState}
        style={styles.automationDeliveryHeader}
        testID="task-detail-automation-delivery-toggle"
      >
        <View style={styles.automationDeliveryTitleGroup}>
          <Text style={styles.automationDeliveryTitle}>Automation &amp; delivery</Text>
          <Text style={styles.automationDeliverySummary} numberOfLines={1}>
            {summary}
          </Text>
        </View>
        {expanded ? (
          <ThemedChevronDown size={ICON_SIZE.sm} uniProps={mutedIconMapping} />
        ) : (
          <ThemedChevronRight size={ICON_SIZE.sm} uniProps={mutedIconMapping} />
        )}
      </Pressable>
      {expanded ? (
        <View style={styles.automationDeliveryContent}>
          <TaskAutomationSection
            serverId={serverId}
            task={task}
            project={project}
            presets={presets}
            hasSubtasks={hasSubtasks}
          />
          <TaskDeliverySection task={task} />
        </View>
      ) : null}
    </View>
  );
}

function TaskDeliverySection({ task }: { task: Task }): ReactElement | null {
  if (!task.integration) return null;
  let status = "Task branch ready";
  if (task.integration.status === "integrated") {
    status = "Delivered to parent";
  } else if (task.integration.status === "conflicted") {
    status = "Needs an integration fix";
  } else if (task.parentTaskId) {
    status = "Will deliver to parent when complete";
  }
  return (
    <SettingsSection title="Delivery" flush testID="task-detail-delivery">
      <View style={settingsStyles.card}>
        <View style={settingsStyles.row}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>{status}</Text>
            <Text style={styles.deliveryBranch} numberOfLines={1}>
              {task.integration.branch}
            </Text>
            {task.integration.error ? (
              <Text style={settingsStyles.rowError}>{task.integration.error}</Text>
            ) : null}
          </View>
        </View>
      </View>
    </SettingsSection>
  );
}

/** A step reads as one line: what it is, what its last run said, and the only
 * actions that run says are possible. */
function WorkflowStepRow({
  step,
  index,
  disabled,
  onAct,
  onOpenAgent,
}: {
  step: Step;
  index: number;
  disabled: boolean;
  onAct: (stepId: string, action: TaskStepAction) => void;
  onOpenAgent: (input: { workspaceId: string; agentId: string }) => void;
}): ReactElement {
  const { t } = useTranslation();
  const { status, actions, error } = resolveStepState(step);
  const primaryAction = actions.find((action) => action !== "skip");
  const hasSkip = actions.includes("skip");
  const agentTarget = resolveStepAgentTarget(step);
  const isActive = status === "running" || status === "queued";
  const isFailed = status === "failed" || status === "interrupted" || status === "canceled";
  const handleOpenAgent = useCallback(() => {
    if (agentTarget) onOpenAgent(agentTarget);
  }, [agentTarget, onOpenAgent]);
  const stepLinkStyle = useCallback(
    ({ pressed, hovered = false }: { pressed: boolean; hovered?: boolean }) => [
      styles.stepLink,
      pressed || hovered ? styles.stepLinkActive : null,
    ],
    [],
  );
  return (
    <View
      style={[styles.stepCard, isActive ? styles.stepCardActive : null]}
      testID={`task-detail-step-${step.id}`}
    >
      <Pressable
        onPress={handleOpenAgent}
        disabled={!agentTarget}
        accessibilityRole={agentTarget ? "button" : undefined}
        accessibilityLabel={
          agentTarget ? `Open chat for step ${index + 1}: ${step.name}` : undefined
        }
        style={stepLinkStyle}
        testID={agentTarget ? `task-detail-step-chat-${step.id}` : undefined}
      >
        <Text style={styles.stepIndex}>{index + 1}</Text>
        <View style={settingsStyles.rowContent}>
          <View style={styles.stepTitleRow}>
            <Text
              style={[styles.stepTitle, isActive ? styles.stepTitleActive : null]}
              numberOfLines={1}
            >
              {step.name}
            </Text>
            <Text
              style={[
                styles.stepStatus,
                status === "succeeded" ? styles.stepStatusSucceeded : null,
                isFailed ? styles.stepStatusFailed : null,
              ]}
            >
              {t(`tasks.detail.stepStatus.${status}`)}
            </Text>
          </View>
          {step.prompt ? (
            <Text style={settingsStyles.rowHint} numberOfLines={2}>
              {step.prompt}
            </Text>
          ) : null}
          <Text style={styles.stepMeta}>
            {step.agents[0]?.model ?? step.agents[0]?.provider ?? "Agent"} ·{" "}
            {formatWorkspaceMode(step)}
          </Text>
          {error ? (
            <Text style={settingsStyles.rowError} testID={`task-detail-step-${step.id}-error`}>
              {error}
            </Text>
          ) : null}
        </View>
        {agentTarget ? (
          <ThemedChevronRight size={ICON_SIZE.sm} uniProps={mutedIconMapping} />
        ) : null}
      </Pressable>
      <WorkflowStepActions
        stepId={step.id}
        primaryAction={primaryAction}
        hasSkip={hasSkip}
        disabled={disabled}
        onAct={onAct}
      />
    </View>
  );
}

function WorkflowStepActions({
  stepId,
  primaryAction,
  hasSkip,
  disabled,
  onAct,
}: {
  stepId: string;
  primaryAction: TaskStepAction | undefined;
  hasSkip: boolean;
  disabled: boolean;
  onAct: (stepId: string, action: TaskStepAction) => void;
}): ReactElement | null {
  if (!primaryAction && !hasSkip) return null;
  return (
    <View style={styles.stepActions}>
      {primaryAction ? (
        <StepActionButton
          stepId={stepId}
          action={primaryAction}
          disabled={disabled}
          onAct={onAct}
        />
      ) : null}
      {hasSkip ? (
        <DropdownMenu>
          <DropdownTrigger testID={`task-detail-step-${stepId}-more`} chevron={null}>
            <Text style={styles.moreAction}>•••</Text>
          </DropdownTrigger>
          <DropdownMenuContent align="end">
            <StepActionMenuItem stepId={stepId} action="skip" disabled={disabled} onAct={onAct} />
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </View>
  );
}

function formatWorkspaceMode(step: Step): string {
  if (step.workspace.mode === "worktree") return "New worktree";
  if (step.workspace.mode === "worktree_per_agent") return "Worktree per agent";
  if (step.workspace.mode === "reuse_previous") return "Previous workspace";
  return "Existing workspace";
}

function StepActionButton({
  stepId,
  action,
  disabled,
  onAct,
}: {
  stepId: string;
  action: TaskStepAction;
  disabled: boolean;
  onAct: (stepId: string, action: TaskStepAction) => void;
}): ReactElement {
  const { t } = useTranslation();
  const handlePress = useCallback(() => onAct(stepId, action), [action, onAct, stepId]);
  return (
    <Button
      variant="ghost"
      size="xs"
      onPress={handlePress}
      disabled={disabled}
      testID={`task-detail-step-${stepId}-${action}`}
    >
      {t(`tasks.detail.stepAction.${action}`)}
    </Button>
  );
}

function StepActionMenuItem({
  stepId,
  action,
  disabled,
  onAct,
}: {
  stepId: string;
  action: TaskStepAction;
  disabled: boolean;
  onAct: (stepId: string, action: TaskStepAction) => void;
}): ReactElement {
  const { t } = useTranslation();
  const handleSelect = useCallback(() => onAct(stepId, action), [action, onAct, stepId]);
  return (
    <DropdownMenuItem disabled={disabled} onSelect={handleSelect}>
      {t(`tasks.detail.stepAction.${action}`)}
    </DropdownMenuItem>
  );
}

function formatReviewPolicy(
  policy: TaskExecutionPolicy,
  effective: ReturnType<typeof resolveTaskExecutionPolicy>,
): string {
  if (policy.review === "required") return "Required";
  if (policy.review === "disabled") return "Disabled";
  return `Board default (${effective.reviewEnabled ? "required" : "off"})`;
}

function formatWorkspacePolicy(policy: TaskExecutionPolicy): string {
  if (policy.workspace === "dedicated") return "Dedicated worktree";
  if (policy.workspace === "reuse") return "Reuse task workspace";
  return "Preset default";
}

function formatReviewerPolicy(
  policy: TaskExecutionPolicy,
  effective: ReturnType<typeof resolveTaskExecutionPolicy>,
  presets: readonly TaskPreset[],
): string {
  if ("reviewerPresetId" in policy) {
    if (!policy.reviewerPresetId) return "Human";
    return (
      presets.find((preset) => preset.id === policy.reviewerPresetId)?.name ?? "Missing preset"
    );
  }
  if (!effective.reviewerPresetId) return "Board default (human)";
  const name = presets.find((preset) => preset.id === effective.reviewerPresetId)?.name ?? "preset";
  return `Board default (${name})`;
}

function selectReviewerPolicy(policy: TaskExecutionPolicy): string {
  if (!("reviewerPresetId" in policy)) return "inherit";
  return policy.reviewerPresetId ?? "human";
}

function formatCleanupPolicy(
  policy: TaskExecutionPolicy,
  effective: ReturnType<typeof resolveTaskExecutionPolicy>,
): string {
  if (policy.archiveWorkspacesOnDone === undefined) {
    return `Board default (${effective.archiveWorkspacesOnDone ? "archive" : "keep"})`;
  }
  return policy.archiveWorkspacesOnDone ? "Archive workspaces" : "Keep workspaces";
}

function selectCleanupPolicy(policy: TaskExecutionPolicy): "inherit" | "archive" | "keep" {
  if (policy.archiveWorkspacesOnDone === undefined) return "inherit";
  return policy.archiveWorkspacesOnDone ? "archive" : "keep";
}

function formatAutomationSummary(
  effective: ReturnType<typeof resolveTaskExecutionPolicy>,
  presets: readonly TaskPreset[],
  reviewMode: ReviewMode | null,
): string {
  let workspace = "Agents use the selected preset's workspace.";
  if (effective.workspace === "dedicated") {
    workspace = "Agents use dedicated worktrees.";
  } else if (effective.workspace === "reuse") {
    workspace = "Agents continue in the task workspace.";
  }
  if (reviewMode) {
    return `${workspace} ${formatReviewModeSummary(reviewMode, effective)}`;
  }
  let review = "No review is required.";
  if (effective.reviewEnabled) {
    const roundLabel = effective.maxReviewIterations === 1 ? "round" : "rounds";
    if (effective.reviewerPresetId) {
      const reviewer =
        presets.find((preset) => preset.id === effective.reviewerPresetId)?.name ?? "An agent";
      review = `${reviewer} reviews the result, with up to ${effective.maxReviewIterations} correction ${roundLabel}.`;
    } else {
      review = `A person reviews the result, with up to ${effective.maxReviewIterations} correction ${roundLabel}.`;
    }
  }
  return `${workspace} ${review}`;
}

function TaskAutomationSection({
  serverId,
  task,
  project,
  presets,
  hasSubtasks,
}: {
  serverId: string;
  task: Task;
  project: TaskProject | undefined;
  presets: readonly TaskPreset[];
  /** An aggregate has two review levels to set, a leaf has one. */
  hasSubtasks: boolean;
}): ReactElement {
  const toast = useToast();
  const supportsExecutionPolicy = useTaskExecutionPolicySupported(serverId);
  const { updateTask } = useTaskMutations(serverId);
  const [policy, setPolicy] = useState<TaskExecutionPolicy>(task.executionPolicy ?? {});
  const [isEditing, setIsEditing] = useState(false);
  const effectivePolicy = resolveTaskExecutionPolicy(project?.board, policy);
  const reviewMode = hasSubtasks ? resolveReviewMode(policy) : null;
  const summary = formatAutomationSummary(effectivePolicy, presets, reviewMode);
  const writePolicy = useCallback(
    (next: TaskExecutionPolicy | null) => {
      const previous = policy;
      setPolicy(next ?? {});
      void updateTask({ taskId: task.id, executionPolicy: next }).catch((error) => {
        setPolicy(previous);
        toast.show(toErrorMessage(error));
      });
    },
    [policy, task.id, toast, updateTask],
  );
  const setReview = useCallback(
    (review: "inherit" | "required" | "disabled") => writePolicy({ ...policy, review }),
    [policy, writePolicy],
  );
  const setReviewMode = useCallback(
    (mode: ReviewMode) => writePolicy(applyReviewMode(policy, mode)),
    [policy, writePolicy],
  );
  const setWorkspace = useCallback(
    (workspace: "inherit" | "dedicated" | "reuse") => writePolicy({ ...policy, workspace }),
    [policy, writePolicy],
  );
  const setReviewer = useCallback(
    (value: string) => {
      if (value === "inherit") {
        const { reviewerPresetId: _removed, ...rest } = policy;
        writePolicy(rest);
        return;
      }
      writePolicy({ ...policy, reviewerPresetId: value === "human" ? null : value });
    },
    [policy, writePolicy],
  );
  const setRounds = useCallback(
    (value: string) => {
      if (value === "inherit") {
        const { maxReviewIterations: _removed, ...rest } = policy;
        writePolicy(rest);
        return;
      }
      writePolicy({ ...policy, maxReviewIterations: Number(value) });
    },
    [policy, writePolicy],
  );
  const setRejectTarget = useCallback(
    (value: "inherit" | "in_progress" | "todo" | "backlog") => {
      if (value === "inherit") {
        const { reviewOnReject: _removed, ...rest } = policy;
        writePolicy(rest);
        return;
      }
      writePolicy({ ...policy, reviewOnReject: value });
    },
    [policy, writePolicy],
  );
  const setCleanup = useCallback(
    (value: "inherit" | "archive" | "keep") => {
      if (value === "inherit") {
        const { archiveWorkspacesOnDone: _removed, ...rest } = policy;
        writePolicy(rest);
        return;
      }
      writePolicy({ ...policy, archiveWorkspacesOnDone: value === "archive" });
    },
    [policy, writePolicy],
  );
  const resetPolicy = useCallback(() => writePolicy(null), [writePolicy]);
  const toggleEditing = useCallback(() => setIsEditing((current) => !current), []);

  const canReset = isEditing && Object.keys(policy).length > 0;
  const trailing = useMemo(
    () =>
      supportsExecutionPolicy ? (
        <AutomationSectionActions
          isEditing={isEditing}
          canReset={canReset}
          onReset={resetPolicy}
          onToggleEditing={toggleEditing}
        />
      ) : null,
    [canReset, isEditing, resetPolicy, supportsExecutionPolicy, toggleEditing],
  );

  return (
    <SettingsSection title="Automation" flush trailing={trailing} testID="task-detail-automation">
      <Text style={styles.automationSummary}>{summary}</Text>
      {supportsExecutionPolicy && isEditing ? (
        <View style={settingsStyles.card}>
          <View style={settingsStyles.row}>
            <Text style={settingsStyles.rowHint}>
              Board defaults apply until this task overrides them.
            </Text>
          </View>
          {reviewMode ? (
            <PolicySelect
              label="Review"
              value={REVIEW_MODE_LABELS[reviewMode]}
              options={REVIEW_MODES.map((mode) => ({ id: mode, label: REVIEW_MODE_LABELS[mode] }))}
              selected={reviewMode}
              onSelect={setReviewMode}
              testID="task-detail-policy-review"
            />
          ) : (
            <PolicySelect
              label="Review"
              value={formatReviewPolicy(policy, effectivePolicy)}
              options={[
                { id: "inherit", label: "Board default" },
                { id: "required", label: "Required" },
                { id: "disabled", label: "Disabled" },
              ]}
              selected={policy.review ?? "inherit"}
              onSelect={setReview}
              testID="task-detail-policy-review"
            />
          )}
          <PolicySelect
            label="Workspace"
            value={formatWorkspacePolicy(policy)}
            options={[
              { id: "inherit", label: "Preset default" },
              { id: "dedicated", label: "Dedicated worktree" },
              { id: "reuse", label: "Reuse task workspace" },
            ]}
            selected={policy.workspace ?? "inherit"}
            onSelect={setWorkspace}
            testID="task-detail-policy-workspace"
          />
          <PolicySelect
            label="Reviewer"
            value={formatReviewerPolicy(policy, effectivePolicy, presets)}
            options={[
              { id: "inherit", label: "Board default" },
              { id: "human", label: "Human" },
              ...presets.map((preset) => ({ id: preset.id, label: preset.name })),
            ]}
            selected={selectReviewerPolicy(policy)}
            onSelect={setReviewer}
            testID="task-detail-policy-reviewer"
          />
          <PolicySelect
            label="Correction rounds"
            value={
              policy.maxReviewIterations
                ? String(policy.maxReviewIterations)
                : `Board default (${effectivePolicy.maxReviewIterations})`
            }
            options={[
              { id: "inherit", label: "Board default" },
              { id: "1", label: "1 round" },
              { id: "2", label: "2 rounds" },
              { id: "3", label: "3 rounds" },
              { id: "5", label: "5 rounds" },
              { id: "10", label: "10 rounds" },
            ]}
            selected={policy.maxReviewIterations?.toString() ?? "inherit"}
            onSelect={setRounds}
            testID="task-detail-policy-rounds"
          />
          <PolicySelect
            label="On rejection"
            value={
              policy.reviewOnReject
                ? policy.reviewOnReject.replaceAll("_", " ")
                : `Board default (${effectivePolicy.reviewOnReject.replaceAll("_", " ")})`
            }
            options={[
              { id: "inherit", label: "Board default" },
              { id: "in_progress", label: "Working" },
              { id: "todo", label: "Todo" },
              { id: "backlog", label: "Backlog" },
            ]}
            selected={policy.reviewOnReject ?? "inherit"}
            onSelect={setRejectTarget}
            testID="task-detail-policy-reject-target"
          />
          <PolicySelect
            label="On completion"
            value={formatCleanupPolicy(policy, effectivePolicy)}
            options={[
              { id: "inherit", label: "Board default" },
              { id: "archive", label: "Archive workspaces" },
              { id: "keep", label: "Keep workspaces" },
            ]}
            selected={selectCleanupPolicy(policy)}
            onSelect={setCleanup}
            testID="task-detail-policy-cleanup"
          />
        </View>
      ) : null}
      {!supportsExecutionPolicy ? (
        <Text style={styles.emptyComments}>
          Update this host to customize automation for individual tasks.
        </Text>
      ) : null}
    </SettingsSection>
  );
}

function AutomationSectionActions({
  isEditing,
  canReset,
  onReset,
  onToggleEditing,
}: {
  isEditing: boolean;
  canReset: boolean;
  onReset: () => void;
  onToggleEditing: () => void;
}): ReactElement {
  return (
    <View style={styles.sectionTrailing}>
      {canReset ? (
        <Button variant="ghost" size="sm" onPress={onReset}>
          Use defaults
        </Button>
      ) : null}
      <Button
        variant="ghost"
        size="sm"
        onPress={onToggleEditing}
        testID="task-detail-automation-edit"
      >
        {isEditing ? "Done" : "Edit"}
      </Button>
    </View>
  );
}

function PolicySelect<T extends string>({
  label,
  value,
  options,
  selected,
  onSelect,
  testID,
}: {
  label: string;
  value: string;
  options: readonly { id: T; label: string }[];
  selected: T;
  onSelect: (value: T) => void;
  testID: string;
}): ReactElement {
  return (
    <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>{label}</Text>
      </View>
      <DropdownMenu>
        <DropdownTrigger testID={testID}>
          <Text style={styles.policyValue} numberOfLines={1}>
            {value}
          </Text>
        </DropdownTrigger>
        <DropdownMenuContent align="end">
          {options.map((option) => (
            <PolicyMenuItem
              key={option.id}
              option={option}
              selected={selected === option.id}
              onSelect={onSelect}
              testID={`${testID}-${option.id}`}
            />
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </View>
  );
}

function PolicyMenuItem<T extends string>({
  option,
  selected,
  onSelect,
  testID,
}: {
  option: { id: T; label: string };
  selected: boolean;
  onSelect: (value: T) => void;
  testID: string;
}): ReactElement {
  const handleSelect = useCallback(() => onSelect(option.id), [onSelect, option.id]);
  return (
    <DropdownMenuItem selected={selected} onSelect={handleSelect} testID={testID}>
      {option.label}
    </DropdownMenuItem>
  );
}

function TaskRelationshipRow({
  label,
  task,
  project,
  withBorder,
}: {
  label: string;
  task: Task;
  project: TaskProject | undefined;
  withBorder: boolean;
}): ReactElement {
  return (
    <View style={[settingsStyles.row, withBorder ? settingsStyles.rowBorder : null]}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle} numberOfLines={1}>
          {task.title}
        </Text>
        <Text style={settingsStyles.rowHint}>
          {label} · {formatTaskKey(project, task)}
        </Text>
      </View>
      <Text style={styles.relationshipStatus}>{task.status.replaceAll("_", " ")}</Text>
    </View>
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

/** A reviewer is named as one: it is on the card to judge the work, not to have
 * done it, and reading the list without that is reading it wrong. */
function AgentRow({
  entry,
  onOpenAgent,
}: {
  entry: TaskExecutionEntry;
  onOpenAgent: (input: { workspaceId: string; agentId: string }) => void;
}): ReactElement {
  const { t } = useTranslation();
  const name = entry.title ?? resolveProviderLabel(entry.provider);
  const detail =
    entry.role === "reviewer"
      ? `${resolveProviderLabel(entry.provider)} · ${t("tasks.detail.reviewerBadge")} · ${TASK_EXECUTION_STATE_LABELS[entry.state]}`
      : `${resolveProviderLabel(entry.provider)} · ${TASK_EXECUTION_STATE_LABELS[entry.state]}`;
  const handlePress = useCallback(
    () => onOpenAgent({ workspaceId: entry.workspaceId, agentId: entry.agentId }),
    [entry.agentId, entry.workspaceId, onOpenAgent],
  );

  return (
    <Pressable
      onPress={handlePress}
      accessibilityRole="button"
      style={[settingsStyles.row, settingsStyles.rowBorder]}
      testID={`task-detail-agent-${entry.agentId}`}
    >
      <View style={styles.agentIdentity}>
        <TaskExecutionStateDot state={entry.state} />
        <View style={settingsStyles.rowContent}>
          <Text style={settingsStyles.rowTitle} numberOfLines={1}>
            {name}
          </Text>
          <Text style={settingsStyles.rowHint} numberOfLines={1}>
            {detail}
          </Text>
        </View>
      </View>
      <ThemedChevronRight size={ICON_SIZE.sm} uniProps={mutedIconMapping} />
    </Pressable>
  );
}

function WorkspaceExecutionGroupCard({
  group,
  onOpenAgent,
}: {
  group: TaskExecutionWorkspaceGroup;
  onOpenAgent: (input: { workspaceId: string; agentId: string }) => void;
}): ReactElement {
  return (
    <View style={settingsStyles.card}>
      <View style={settingsStyles.row}>
        <View style={settingsStyles.rowContent}>
          <Text style={settingsStyles.rowTitle} numberOfLines={1}>
            {group.workspaceName}
          </Text>
          <Text style={settingsStyles.rowHint} numberOfLines={1}>
            {workspaceExecutionDetail({
              branch: group.branch,
              pullRequestNumber: group.pullRequestNumber,
              agentCount: group.entries.length,
            })}
          </Text>
        </View>
      </View>
      {group.entries.map((entry) => (
        <AgentRow key={entry.agentId} entry={entry} onOpenAgent={onOpenAgent} />
      ))}
    </View>
  );
}

function workspaceExecutionDetail(input: {
  branch: string | null;
  pullRequestNumber: number | null;
  agentCount: number;
}): string {
  const details = [input.branch];
  if (input.pullRequestNumber !== null) details.push(`PR #${input.pullRequestNumber}`);
  details.push(`${input.agentCount} ${input.agentCount === 1 ? "agent" : "agents"}`);
  return details.filter((detail): detail is string => Boolean(detail)).join(" · ");
}

const styles = StyleSheet.create((theme) => ({
  taskKey: {
    color: theme.colors.foregroundMuted,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
  },
  headerTitleInput: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.medium,
    textAlign: "center",
    paddingVertical: theme.spacing[1],
  },
  startWorkTrigger: {
    minHeight: 32,
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  startWorkLabel: {
    color: theme.colors.accentForeground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  propertyScroller: {
    backgroundColor: theme.colors.surface0,
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  propertyRow: {
    minHeight: 44,
    paddingHorizontal: theme.spacing[6],
    alignItems: "center",
    gap: theme.spacing[6],
  },
  property: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  propertyLabel: {
    color: theme.colors.foregroundExtraMuted,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
    textTransform: "uppercase",
  },
  propertyValue: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  propertyEmpty: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  tabBar: {
    minHeight: 42,
    paddingHorizontal: theme.spacing[6],
    flexDirection: "row",
    alignItems: "stretch",
    gap: theme.spacing[6],
    backgroundColor: theme.colors.surface1,
  },
  tab: {
    justifyContent: "center",
    paddingHorizontal: theme.spacing[1],
    borderBottomWidth: 2,
    borderBottomColor: "transparent",
  },
  tabActive: {
    borderBottomColor: theme.colors.accentBright,
  },
  tabLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  tabLabelActive: {
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.medium,
  },
  tabContent: {
    gap: theme.spacing[6],
  },
  stepLink: {
    minWidth: 0,
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    padding: theme.spacing[3],
  },
  stepLinkActive: {
    backgroundColor: theme.colors.surface2,
  },
  planSteps: {
    gap: theme.spacing[2],
  },
  stepCard: {
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
  },
  stepCardActive: {
    borderColor: theme.colors.statusDotRunning,
    backgroundColor: theme.colors.surface2,
  },
  stepIndex: {
    alignSelf: "flex-start",
    minWidth: 14,
    color: theme.colors.foregroundExtraMuted,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
    lineHeight: 20,
    textAlign: "right",
  },
  stepTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  stepTitle: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    lineHeight: 20,
  },
  stepTitleActive: {
    color: theme.colors.accentBright,
  },
  stepMeta: {
    color: theme.colors.foregroundMuted,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
  },
  stepActions: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingBottom: theme.spacing[2],
  },
  stepStatus: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  stepStatusSucceeded: {
    color: theme.colors.statusSuccess,
  },
  stepStatusFailed: {
    color: theme.colors.statusDanger,
  },
  moreAction: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  blocker: {
    color: theme.colors.statusWarning,
    fontSize: theme.fontSize.sm,
  },
  groupContent: {
    gap: theme.spacing[6],
  },
  detailsDescriptionInput: {
    minHeight: 120,
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
    fontSize: theme.fontSize.sm,
    lineHeight: 20,
    padding: theme.spacing[4],
  },
  inlineInput: {
    flex: 1,
    fontSize: theme.fontSize.sm,
  },
  sectionTrailing: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  actionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  automationSummary: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    lineHeight: 20,
  },
  automationDelivery: {
    overflow: "hidden",
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface2,
  },
  automationDeliveryHeader: {
    minHeight: 52,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
  },
  automationDeliveryTitleGroup: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing[1],
  },
  automationDeliveryTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  automationDeliverySummary: {
    color: theme.colors.foregroundMuted,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
  },
  automationDeliveryContent: {
    gap: theme.spacing[6],
    padding: theme.spacing[4],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  deliveryBranch: {
    color: theme.colors.foregroundMuted,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
    marginTop: theme.spacing[1],
  },
  agentIdentity: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  executionGroups: {
    gap: theme.spacing[2],
  },
  activityEmpty: {
    paddingVertical: theme.spacing[8],
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
  policyValue: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  relationshipStatus: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    textTransform: "capitalize",
  },
  fieldFill: {
    flex: 1,
    maxHeight: 120,
  },
  emptyComments: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  unifiedComposerFooter: {
    alignItems: "stretch",
    backgroundColor: theme.colors.surface1,
  },
  unifiedComposer: {
    flex: 1,
    gap: theme.spacing[2],
  },
  composerModeRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  composerInputRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: theme.spacing[2],
  },
}));
