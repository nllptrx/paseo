import { useCallback, useMemo, useState, type ReactElement } from "react";
import { Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { ChevronRight, SendHorizontal } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type {
  Task,
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
import { SettingsSection } from "@/screens/settings/settings-section";
import { settingsStyles } from "@/styles/settings";
import { ICON_SIZE, type Theme } from "@/styles/theme";
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
import {
  resolveStepState,
  useTaskStepActions,
  type TaskStepAction,
} from "@/tasks/use-task-workflow";
import { useBoardFeed, useBoardFeedComposer } from "@/tasks/use-board-feed";
import {
  useTaskExecutionPolicySupported,
  useTaskMessagesSupported,
  useTaskMutations,
} from "@/tasks/use-tasks";
import { useSessionStore } from "@/stores/session-store";
import { toErrorMessage } from "@/utils/error-messages";
import { BoardFeedEntryRow } from "./board-feed-entry";
import { TaskExecutionStateDot } from "./task-execution-summary";
import {
  TASK_PRIORITY_LABEL_KEYS,
  TASK_STATUS_LABEL_KEYS,
  TaskLabelChips,
} from "./task-board-parts";
import {
  groupTaskExecutionsByWorkspace,
  TASK_EXECUTION_STATE_LABELS,
  type TaskExecutionEntry,
  type TaskExecutionSummary,
  type TaskExecutionWorkspaceGroup,
} from "@/tasks/task-execution";
import { resolveProviderLabel } from "@/tasks/use-task-available-providers";

const TASK_PRIORITIES: readonly TaskPriority[] = ["none", "urgent", "high", "medium", "low"];

const ThemedChevronRight = withUnistyles(ChevronRight);

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
  onEditWorkflow: (taskId: string, existingSteps?: readonly Step[]) => void;
  labels: readonly TaskLabel[];
  onClose: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const toast = useToast();
  const { setStatus, setPriority, reviewTask, updateTask, createTask, isReviewing, isBusy } =
    useTaskMutations(serverId);
  const { entries } = useBoardFeed({ serverId, projectId: task.projectId });
  const { post, sendMessage, isPosting } = useBoardFeedComposer({
    serverId,
    projectId: task.projectId,
  });
  const supportsMessages = useTaskMessagesSupported(serverId);
  const [noteDraft, setNoteDraft] = useState("");
  const [reviewFeedback, setReviewFeedback] = useState("");
  const [titleDraft, setTitleDraft] = useState(task.title);
  const [descriptionDraft, setDescriptionDraft] = useState(task.description);
  const [subtaskDraft, setSubtaskDraft] = useState("");
  const [noteResetKey, setNoteResetKey] = useState(0);
  const [subtaskResetKey, setSubtaskResetKey] = useState(0);
  const executionGroups = useMemo(
    () => groupTaskExecutionsByWorkspace(executionSummary),
    [executionSummary],
  );

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
  const relationships = useMemo<readonly { label: string; task: Task }[]>(
    () => [
      ...(parent ? [{ label: "Parent", task: parent }] : []),
      ...dependenciesForTask.map((dependency) => ({ label: "Waits for", task: dependency })),
      ...subtasks.map((subtask) => ({ label: "Subtask", task: subtask })),
    ],
    [dependenciesForTask, parent, subtasks],
  );
  // The verdict belongs where the change is read, not only in the card's menu:
  // someone who opened the task to judge it should not have to close it again to
  // say what they decided.
  const handleReview = useCallback(
    (verdict: "approve" | "reject") => {
      void reviewTask({
        taskId: task.id,
        verdict,
        feedback: verdict === "reject" ? reviewFeedback.trim() || undefined : undefined,
      })
        .then((reviewedTask) => {
          if (verdict === "reject" && reviewedTask.status === "in_review") {
            toast.show("The task remains in Review; no correction round was started.");
          }
          return reviewedTask;
        })
        .catch((error) => {
          toast.show(toErrorMessage(error));
        });
    },
    [reviewFeedback, reviewTask, task.id, toast],
  );
  const handleApprove = useCallback(() => handleReview("approve"), [handleReview]);
  const handleReject = useCallback(() => handleReview("reject"), [handleReview]);

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
    const title = subtaskDraft.trim();
    if (!title) {
      return;
    }
    setSubtaskDraft("");
    setSubtaskResetKey((current) => current + 1);
    void createTask({ projectId: task.projectId, title, parentTaskId: task.id }).catch((error) => {
      setSubtaskDraft(title);
      setSubtaskResetKey((current) => current + 1);
      toast.show(toErrorMessage(error));
    });
  }, [createTask, subtaskDraft, task.id, task.projectId, toast]);

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

  const header = useMemo(() => ({ title: formatTaskKey(project, task) }), [project, task]);
  const workflowTrailing = useMemo(
    () => (
      <Button
        variant="ghost"
        size="sm"
        onPress={handleEditWorkflow}
        testID="task-detail-workflow-edit"
      >
        {workflow ? "Edit" : "Add plan"}
      </Button>
    ),
    [handleEditWorkflow, workflow],
  );

  return (
    <AdaptiveModalSheet
      header={header}
      visible
      onClose={onClose}
      desktopMaxWidth={720}
      testID="task-detail-sheet"
    >
      <View style={styles.body}>
        <View style={styles.brief} testID="task-detail-brief">
          <AdaptiveTextInput
            initialValue={task.title}
            resetKey={task.title}
            onChangeText={setTitleDraft}
            onBlur={saveBrief}
            onEndEditing={saveBrief}
            placeholder="What needs to be done?"
            style={styles.titleInput}
            testID="task-detail-title-input"
          />
          <AdaptiveTextInput
            initialValue={task.description}
            resetKey={task.description}
            onChangeText={setDescriptionDraft}
            onBlur={saveBrief}
            onEndEditing={saveBrief}
            placeholder="Describe the outcome, context, and constraints for the agent"
            style={styles.descriptionInput}
            multiline
            testID="task-detail-description-input"
          />
        </View>
        <View style={styles.fieldRow}>
          <DropdownMenu>
            <DropdownTrigger style={styles.fieldTrigger} testID="task-detail-status-trigger">
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
            <DropdownTrigger style={styles.fieldTrigger} testID="task-detail-priority-trigger">
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

        <TaskLabelChips labels={taskLabels} />

        {task.dueDate ? (
          <Text style={styles.dueDate}>{t("tasks.detail.due", { date: task.dueDate })}</Text>
        ) : null}

        {task.status === "in_review" ? (
          <SettingsSection
            title={t("tasks.detail.reviewerHeading")}
            flush
            testID="task-detail-review"
          >
            <FormTextInput
              onChangeText={setReviewFeedback}
              placeholder="Correction feedback (sent to the worker on rejection)"
              multiline
              editable={!isReviewing}
              testID="task-detail-review-feedback"
            />
            {task.reviewIteration ? (
              <Text style={settingsStyles.rowHint}>Correction round {task.reviewIteration}</Text>
            ) : null}
            <View style={styles.actionRow}>
              <Button
                variant="default"
                size="sm"
                onPress={handleApprove}
                loading={isReviewing}
                testID="task-detail-approve"
              >
                {t("tasks.board.approve")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onPress={handleReject}
                disabled={isReviewing}
                testID="task-detail-reject"
              >
                {t("tasks.board.reject")}
              </Button>
            </View>
          </SettingsSection>
        ) : null}

        {blockers.length > 0 ? (
          <SettingsSection
            title={t("tasks.detail.blockedHeading")}
            flush
            testID="task-detail-blockers"
          >
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
        ) : null}

        {presets.length > 0 ? (
          <SettingsSection title={t("tasks.detail.startHeading")} flush>
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
          </SettingsSection>
        ) : null}

        <SettingsSection
          title="Agent plan"
          flush
          testID="task-detail-workflow"
          trailing={workflowTrailing}
        >
          <Text style={settingsStyles.rowHint}>
            The task brief is sent with every step. Add instructions only where they differ.
          </Text>
          {workflow && workflow.steps.length > 0 ? (
            <View style={settingsStyles.card}>
              {workflow.steps.map((step, index) => (
                <WorkflowStepRow
                  key={step.id}
                  step={step}
                  index={index}
                  disabled={isActing}
                  onAct={handleStepAction}
                />
              ))}
            </View>
          ) : (
            <Text style={styles.emptyComments}>
              No saved plan. Start from a preset, or add a multi-step agent plan.
            </Text>
          )}
        </SettingsSection>

        <TaskAutomationSection
          serverId={serverId}
          task={task}
          project={project}
          presets={presets}
        />

        <TaskDeliverySection task={task} />

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
            <View
              style={[
                settingsStyles.row,
                relationships.length > 0 ? settingsStyles.rowBorder : null,
              ]}
            >
              <AdaptiveTextInput
                initialValue={subtaskDraft}
                resetKey={subtaskResetKey}
                onChangeText={setSubtaskDraft}
                onSubmitEditing={createSubtask}
                placeholder="Add a subtask"
                style={styles.inlineInput}
                testID="task-detail-subtask-input"
              />
              <Button
                variant="ghost"
                size="sm"
                onPress={createSubtask}
                disabled={!subtaskDraft.trim() || isBusy}
                testID="task-detail-subtask-add"
              >
                Add
              </Button>
            </View>
          </View>
        </SettingsSection>

        {task.attachments.length > 0 ? (
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
        ) : null}

        {executionGroups.length > 0 ? (
          <SettingsSection title={t("tasks.detail.agentsHeading")} flush>
            <View style={styles.executionGroups}>
              {executionGroups.map((group) => (
                <WorkspaceExecutionGroupCard
                  key={group.workspaceId}
                  group={group}
                  onOpenAgent={handleOpenAgent}
                />
              ))}
            </View>
          </SettingsSection>
        ) : null}

        <SettingsSection title={t("tasks.detail.commentsHeading")} flush>
          {comments.length > 0
            ? comments.map((entry) => (
                <BoardFeedEntryRow key={entry.id} entry={entry} serverId={serverId} />
              ))
            : null}
          <Text style={settingsStyles.rowHint}>Saved to history. Agents are not notified.</Text>
          <View style={styles.composer}>
            <View style={styles.fieldFill}>
              <FormTextInput
                initialValue={noteDraft}
                resetKey={noteResetKey}
                onChangeText={setNoteDraft}
                onSubmitEditing={submitNote}
                placeholder="Write a note"
                multiline
                testID="task-detail-comment-input"
              />
            </View>
            <Button
              variant="ghost"
              size="sm"
              onPress={submitNote}
              disabled={noteDraft.trim().length === 0 || isPosting}
              testID="task-detail-comment-send"
            >
              Add note
            </Button>
          </View>
        </SettingsSection>

        {task.agents.length > 0 ? (
          <TaskMessageComposer
            serverId={serverId}
            task={task}
            supportsMessages={supportsMessages}
            sendMessage={sendMessage}
            isPosting={isPosting}
          />
        ) : null}
      </View>
    </AdaptiveModalSheet>
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

/** A step reads as one line: what it is, what its last run said, and the only
 * actions that run says are possible. */
function WorkflowStepRow({
  step,
  index,
  disabled,
  onAct,
}: {
  step: Step;
  index: number;
  disabled: boolean;
  onAct: (stepId: string, action: TaskStepAction) => void;
}): ReactElement {
  const { t } = useTranslation();
  const { status, actions, error } = resolveStepState(step);
  const primaryAction = actions.find((action) => action !== "skip");
  const hasSkip = actions.includes("skip");
  return (
    <View
      style={[settingsStyles.row, index > 0 ? settingsStyles.rowBorder : null]}
      testID={`task-detail-step-${step.id}`}
    >
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle} numberOfLines={1}>
          {index + 1}. {step.name}
        </Text>
        <Text style={settingsStyles.rowHint} numberOfLines={2}>
          {step.prompt}
        </Text>
        <Text style={settingsStyles.rowHint}>
          {step.agents[0]?.model ?? step.agents[0]?.provider ?? "Agent"} ·{" "}
          {formatWorkspaceMode(step)}
        </Text>
        {error ? (
          <Text style={settingsStyles.rowError} testID={`task-detail-step-${step.id}-error`}>
            {error}
          </Text>
        ) : null}
      </View>
      <View style={styles.rowTrailing}>
        <Text style={styles.stepStatus}>{t(`tasks.detail.stepStatus.${status}`)}</Text>
        {primaryAction ? (
          <StepActionButton
            stepId={step.id}
            action={primaryAction}
            disabled={disabled}
            onAct={onAct}
          />
        ) : null}
        {hasSkip ? (
          <DropdownMenu>
            <DropdownTrigger testID={`task-detail-step-${step.id}-more`} chevron={null}>
              <Text style={styles.moreAction}>•••</Text>
            </DropdownTrigger>
            <DropdownMenuContent align="end">
              <StepActionMenuItem
                stepId={step.id}
                action="skip"
                disabled={disabled}
                onAct={onAct}
              />
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </View>
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

function formatSubtaskPolicy(policy: TaskExecutionPolicy): string {
  if (policy.maxParallelSubtasks === 1) return "One at a time";
  if (policy.maxParallelSubtasks) return `Up to ${policy.maxParallelSubtasks}`;
  return "Can start together";
}

function formatAutomationSummary(
  effective: ReturnType<typeof resolveTaskExecutionPolicy>,
  presets: readonly TaskPreset[],
): string {
  let workspace = "Agents use the selected preset's workspace.";
  if (effective.workspace === "dedicated") {
    workspace = "Agents use dedicated worktrees.";
  } else if (effective.workspace === "reuse") {
    workspace = "Agents continue in the task workspace.";
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
  const subtasks = effective.maxParallelSubtasks
    ? `Up to ${effective.maxParallelSubtasks} ${effective.maxParallelSubtasks === 1 ? "subtask runs" : "subtasks run"} at once.`
    : "Ready subtasks can run together.";
  return `${workspace} ${review} ${subtasks}`;
}

function TaskAutomationSection({
  serverId,
  task,
  project,
  presets,
}: {
  serverId: string;
  task: Task;
  project: TaskProject | undefined;
  presets: readonly TaskPreset[];
}): ReactElement {
  const toast = useToast();
  const supportsExecutionPolicy = useTaskExecutionPolicySupported(serverId);
  const { updateTask } = useTaskMutations(serverId);
  const [policy, setPolicy] = useState<TaskExecutionPolicy>(task.executionPolicy ?? {});
  const [isEditing, setIsEditing] = useState(false);
  const effectivePolicy = resolveTaskExecutionPolicy(project?.board, policy);
  const summary = formatAutomationSummary(effectivePolicy, presets);
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
  const setWorkspace = useCallback(
    (workspace: "inherit" | "dedicated" | "reuse") => writePolicy({ ...policy, workspace }),
    [policy, writePolicy],
  );
  const setParallel = useCallback(
    (value: string) => {
      if (value === "host") {
        const { maxParallelSubtasks: _removed, ...rest } = policy;
        writePolicy(rest);
        return;
      }
      writePolicy({ ...policy, maxParallelSubtasks: Number(value) });
    },
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
          <PolicySelect
            label="New subtasks"
            value={formatSubtaskPolicy(policy)}
            options={[
              { id: "host", label: "Can start together" },
              { id: "1", label: "One at a time" },
              { id: "2", label: "Up to 2" },
              { id: "3", label: "Up to 3" },
              { id: "4", label: "Up to 4" },
            ]}
            selected={policy.maxParallelSubtasks?.toString() ?? "host"}
            onSelect={setParallel}
            testID="task-detail-policy-subtasks"
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

function TaskMessageComposer({
  serverId,
  task,
  supportsMessages,
  sendMessage,
  isPosting,
}: {
  serverId: string;
  task: Task;
  supportsMessages: boolean;
  sendMessage: (input: {
    body: string;
    taskId: string;
    recipientAgentIds: string[];
  }) => Promise<void>;
  isPosting: boolean;
}): ReactElement {
  const toast = useToast();
  const [draft, setDraft] = useState("");
  const [draftResetKey, setDraftResetKey] = useState(0);
  const [recipientAgentIds, setRecipientAgentIds] = useState<Set<string>>(() => new Set());
  const toggleRecipient = useCallback((agentId: string) => {
    setRecipientAgentIds((current) => {
      const next = new Set(current);
      if (next.has(agentId)) {
        next.delete(agentId);
      } else {
        next.add(agentId);
      }
      return next;
    });
  }, []);
  const submit = useCallback(() => {
    const body = draft.trim();
    const recipients = [...recipientAgentIds];
    if (!body || recipients.length === 0 || isPosting) {
      return;
    }
    setDraft("");
    setDraftResetKey((current) => current + 1);
    void sendMessage({ body, taskId: task.id, recipientAgentIds: recipients }).catch((error) => {
      setDraft(body);
      setDraftResetKey((current) => current + 1);
      toast.show(toErrorMessage(error));
    });
  }, [draft, isPosting, recipientAgentIds, sendMessage, task.id, toast]);

  return (
    <SettingsSection title="Send message" flush testID="task-detail-message-composer">
      <Text style={settingsStyles.rowHint}>
        Select attached agents. Delivered means the daemon accepted the prompt, not that the agent
        read or acknowledged it.
      </Text>
      {supportsMessages ? (
        <>
          <View style={styles.recipientPicker}>
            {task.agents.map((link) => (
              <RecipientButton
                key={link.agentId}
                serverId={serverId}
                agentId={link.agentId}
                workspaceId={link.workspaceId}
                selected={recipientAgentIds.has(link.agentId)}
                onToggle={toggleRecipient}
              />
            ))}
          </View>
          <View style={styles.composer}>
            <View style={styles.fieldFill}>
              <FormTextInput
                initialValue={draft}
                resetKey={draftResetKey}
                onChangeText={setDraft}
                placeholder="Write an instruction"
                multiline
                testID="task-detail-message-input"
              />
            </View>
            <Button
              variant="secondary"
              size="sm"
              leftIcon={SendHorizontal}
              onPress={submit}
              disabled={!draft.trim() || recipientAgentIds.size === 0 || isPosting}
              testID="task-detail-message-send"
            >
              Send
            </Button>
          </View>
        </>
      ) : (
        <Text style={styles.emptyComments}>Update this host to send task messages.</Text>
      )}
    </SettingsSection>
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

function RecipientButton({
  serverId,
  agentId,
  workspaceId,
  selected,
  onToggle,
}: {
  serverId: string;
  agentId: string;
  workspaceId: string;
  selected: boolean;
  onToggle: (agentId: string) => void;
}): ReactElement {
  const workspace = useWorkspace(serverId, workspaceId);
  const agent = useSessionStore((state) => state.sessions[serverId]?.agents.get(agentId));
  const name = agent?.title ?? workspace?.title ?? workspace?.name ?? "Agent";
  const handlePress = useCallback(() => onToggle(agentId), [agentId, onToggle]);
  return (
    <Button
      variant={selected ? "secondary" : "outline"}
      size="sm"
      onPress={handlePress}
      testID={`task-detail-message-recipient-${agentId}`}
    >
      {name} · {agent?.provider ?? "agent"} · {agentId}
    </Button>
  );
}

const styles = StyleSheet.create((theme) => ({
  rowTrailing: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  stepStatus: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  moreAction: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
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
  },
  brief: {
    gap: theme.spacing[1],
  },
  titleInput: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
    paddingVertical: theme.spacing[1],
  },
  descriptionInput: {
    minHeight: 44,
    fontSize: theme.fontSize.sm,
    lineHeight: 20,
    paddingVertical: theme.spacing[1],
  },
  inlineInput: {
    flex: 1,
    fontSize: theme.fontSize.sm,
  },
  fieldRow: {
    flexDirection: "row",
    gap: theme.spacing[2],
  },
  fieldTrigger: {
    minHeight: 32,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface1,
  },
  fieldValue: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
  },
  dueDate: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
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
  recipientPicker: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  composer: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: theme.spacing[2],
  },
}));
