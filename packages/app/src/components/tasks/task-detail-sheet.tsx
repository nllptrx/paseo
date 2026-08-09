import { useCallback, useMemo, useState, type ReactElement } from "react";
import { Text, TextInput, View } from "react-native";
import { useTranslation } from "react-i18next";
import { SendHorizontal } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
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
import {
  resolveStepState,
  useTaskStepActions,
  type TaskStepAction,
} from "@/tasks/use-task-workflow";
import { useBoardFeed, useBoardFeedComposer } from "@/tasks/use-board-feed";
import { useTaskExecutionPolicySupported, useTaskMutations } from "@/tasks/use-tasks";
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
  workflows: readonly TaskWorkflow[];
  /** Opens the workflow editor for this task; the board owns that sheet. */
  onEditWorkflow: (taskId: string) => void;
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
  onEditWorkflow: (taskId: string) => void;
  labels: readonly TaskLabel[];
  onClose: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const toast = useToast();
  const { setStatus, setPriority, reviewTask, updateTask, createTask, isReviewing, isBusy } =
    useTaskMutations(serverId);
  const { entries } = useBoardFeed({ serverId, projectId: task.projectId });
  const { post, isPosting } = useBoardFeedComposer({ serverId, projectId: task.projectId });
  const [draft, setDraft] = useState("");
  const [reviewFeedback, setReviewFeedback] = useState("");
  const [titleDraft, setTitleDraft] = useState(task.title);
  const [descriptionDraft, setDescriptionDraft] = useState(task.description);
  const [subtaskDraft, setSubtaskDraft] = useState("");

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
  const handleEditWorkflow = useCallback(() => onEditWorkflow(task.id), [onEditWorkflow, task.id]);

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
    void createTask({ projectId: task.projectId, title, parentTaskId: task.id }).catch((error) => {
      setSubtaskDraft(title);
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

  const submitComment = useCallback(
    (notifyTaskAgents: boolean) => {
      const body = draft.trim();
      if (body.length === 0 || isPosting) {
        return;
      }
      setDraft("");
      void post({ body, taskId: task.id, notifyTaskAgents }).catch((error) => {
        setDraft(body);
        toast.show(toErrorMessage(error));
      });
    },
    [draft, isPosting, post, task.id, toast],
  );
  const handleComment = useCallback(() => submitComment(false), [submitComment]);
  const handleCommentAndSend = useCallback(() => submitComment(true), [submitComment]);

  const header = useMemo(
    () => ({ title: formatTaskKey(project, task), subtitle: task.title }),
    [project, task],
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
          <TextInput
            value={titleDraft}
            onChangeText={setTitleDraft}
            onBlur={saveBrief}
            onEndEditing={saveBrief}
            placeholder="What needs to be done?"
            placeholderTextColor={styles.placeholder.color}
            style={styles.titleInput}
            testID="task-detail-title-input"
          />
          <TextInput
            value={descriptionDraft}
            onChangeText={setDescriptionDraft}
            onBlur={saveBrief}
            onEndEditing={saveBrief}
            placeholder="Describe the outcome, context, and constraints for the agent"
            placeholderTextColor={styles.placeholder.color}
            style={styles.descriptionInput}
            multiline
            testID="task-detail-description-input"
          />
        </View>
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

        <TaskLabelChips labels={taskLabels} />

        {task.dueDate ? (
          <Text style={styles.dueDate}>{t("tasks.detail.due", { date: task.dueDate })}</Text>
        ) : null}

        <View style={styles.section} testID="task-detail-workflow">
          <View style={styles.sectionTitleRow}>
            <View style={styles.sectionTitleCopy}>
              <Text style={styles.sectionHeading}>Agent plan</Text>
              <Text style={styles.sectionHint}>
                The task brief is sent with every step. Add instructions only where they differ.
              </Text>
            </View>
            <Button
              variant="ghost"
              size="sm"
              onPress={handleEditWorkflow}
              testID="task-detail-workflow-edit"
            >
              {workflow ? "Edit" : "Add plan"}
            </Button>
          </View>
          {workflow && workflow.steps.length > 0 ? (
            workflow.steps.map((step, index) => (
              <WorkflowStepRow
                key={step.id}
                step={step}
                index={index}
                disabled={isActing}
                onAct={handleStepAction}
              />
            ))
          ) : (
            <Text style={styles.emptyComments}>
              No saved plan. Start with a preset below, or add a multi-step agent plan.
            </Text>
          )}
        </View>

        <TaskAutomationSection
          serverId={serverId}
          task={task}
          project={project}
          presets={presets}
        />

        <TaskDeliverySection task={task} />

        <View style={styles.section} testID="task-detail-relationships">
          <Text style={styles.sectionHeading}>Relationships</Text>
          {parent ? (
            <TaskRelationshipRow
              label="Parent"
              task={parent}
              project={projectsById.get(parent.projectId)}
            />
          ) : null}
          {dependenciesForTask.map((dependency) => (
            <TaskRelationshipRow
              key={dependency.id}
              label="Waits for"
              task={dependency}
              project={projectsById.get(dependency.projectId)}
            />
          ))}
          {subtasks.map((subtask) => (
            <TaskRelationshipRow
              key={subtask.id}
              label="Subtask"
              task={subtask}
              project={projectsById.get(subtask.projectId)}
            />
          ))}
          <View style={styles.subtaskComposer}>
            <TextInput
              value={subtaskDraft}
              onChangeText={setSubtaskDraft}
              onSubmitEditing={createSubtask}
              placeholder="Add a subtask"
              placeholderTextColor={styles.placeholder.color}
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

        {task.attachments.length > 0 ? (
          <View style={styles.section} testID="task-detail-attachments">
            <Text style={styles.sectionHeading}>Attachments</Text>
            {task.attachments.map((attachment) => (
              <Text key={attachment.id} style={styles.relationshipValue}>
                {attachment.fileName}
              </Text>
            ))}
          </View>
        ) : null}

        {task.status === "in_review" ? (
          <View style={styles.section} testID="task-detail-review">
            <Text style={styles.sectionHeading}>{t("tasks.detail.reviewerHeading")}</Text>
            <TextInput
              value={reviewFeedback}
              onChangeText={setReviewFeedback}
              placeholder="Correction feedback (sent to the worker on rejection)"
              placeholderTextColor={styles.placeholder.color}
              style={styles.input}
              multiline
              editable={!isReviewing}
              testID="task-detail-review-feedback"
            />
            {task.reviewIteration ? (
              <Text style={styles.emptyComments}>Correction round {task.reviewIteration}</Text>
            ) : null}
            <View style={styles.presetRow}>
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
          </View>
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
                role={link.role ?? "worker"}
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
            onSubmitEditing={handleComment}
            placeholder={t("tasks.detail.commentPlaceholder")}
            placeholderTextColor={styles.placeholder.color}
            style={styles.input}
            multiline
            testID="task-detail-comment-input"
          />
          <Button
            variant="ghost"
            size="sm"
            onPress={handleComment}
            disabled={draft.trim().length === 0 || isPosting}
            testID="task-detail-comment-send"
          >
            {t("tasks.detail.commentSend")}
          </Button>
          {task.agents.length > 0 ? (
            <Button
              variant="default"
              size="sm"
              leftIcon={SendHorizontal}
              onPress={handleCommentAndSend}
              disabled={draft.trim().length === 0 || isPosting}
              testID="task-detail-comment-notify"
            >
              {t("tasks.detail.commentNotify", { count: task.agents.length })}
            </Button>
          ) : null}
        </View>
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
    <View style={styles.section} testID="task-detail-delivery">
      <Text style={styles.sectionHeading}>Delivery</Text>
      <View style={styles.deliveryRow}>
        <Text style={styles.deliveryStatus}>{status}</Text>
        <Text style={styles.deliveryBranch} numberOfLines={1}>
          {task.integration.branch}
        </Text>
      </View>
      {task.integration.error ? (
        <Text style={styles.deliveryError}>{task.integration.error}</Text>
      ) : null}
    </View>
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
    <View style={styles.step} testID={`task-detail-step-${step.id}`}>
      <View style={styles.stepRow}>
        <View style={styles.stepCopy}>
          <Text style={styles.stepName} numberOfLines={1}>
            {index + 1}. {step.name}
          </Text>
          <Text style={styles.stepBrief} numberOfLines={2}>
            {step.prompt}
          </Text>
          <Text style={styles.stepMeta}>
            {step.agents[0]?.model ?? step.agents[0]?.provider ?? "Agent"} ·{" "}
            {formatWorkspaceMode(step)}
          </Text>
        </View>
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
            <DropdownTrigger testID={`task-detail-step-${step.id}-more`}>
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
      {error ? (
        <Text style={styles.stepError} testID={`task-detail-step-${step.id}-error`}>
          {error}
        </Text>
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

  return (
    <View style={styles.section} testID="task-detail-automation">
      <View style={styles.sectionTitleRow}>
        <View style={styles.sectionTitleCopy}>
          <Text style={styles.sectionHeading}>Automation</Text>
          <Text style={styles.automationSummary}>{summary}</Text>
        </View>
        {supportsExecutionPolicy ? (
          <Button
            variant="ghost"
            size="xs"
            onPress={toggleEditing}
            testID="task-detail-automation-edit"
          >
            {isEditing ? "Done" : "Edit"}
          </Button>
        ) : null}
      </View>
      {supportsExecutionPolicy && isEditing ? (
        <View style={styles.policyEditor}>
          <View style={styles.policyEditorHeader}>
            <Text style={styles.sectionHint}>
              Board defaults apply until this task overrides them.
            </Text>
            {Object.keys(policy).length > 0 ? (
              <Button variant="ghost" size="xs" onPress={resetPolicy}>
                Use defaults
              </Button>
            ) : null}
          </View>
          <View style={styles.policyGrid}>
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
        </View>
      ) : null}
      {!supportsExecutionPolicy ? (
        <Text style={styles.emptyComments}>
          Update this host to customize automation for individual tasks.
        </Text>
      ) : null}
      {supportsExecutionPolicy && !isEditing ? (
        <Text style={styles.sectionHint}>Uses the board defaults unless you edit this task.</Text>
      ) : null}
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
    <View style={styles.policyItem}>
      <Text style={styles.policyLabel}>{label}</Text>
      <DropdownMenu>
        <DropdownTrigger testID={testID}>
          <Text style={styles.policyValue} numberOfLines={1}>
            {value}
          </Text>
        </DropdownTrigger>
        <DropdownMenuContent align="start">
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
}: {
  label: string;
  task: Task;
  project: TaskProject | undefined;
}): ReactElement {
  return (
    <View style={styles.relationshipRow}>
      <Text style={styles.relationshipLabel}>{label}</Text>
      <Text style={styles.relationshipValue} numberOfLines={1}>
        {formatTaskKey(project, task)} · {task.title}
      </Text>
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
  serverId,
  workspaceId,
  agentId,
  role,
  onOpenAgent,
}: {
  serverId: string;
  workspaceId: string;
  agentId: string;
  role: "worker" | "reviewer";
  onOpenAgent: (input: { workspaceId: string; agentId: string }) => void;
}): ReactElement {
  const { t } = useTranslation();
  const workspace = useWorkspace(serverId, workspaceId);
  const name = workspace?.title ?? workspace?.name ?? workspaceId;
  const label = role === "reviewer" ? `${name} · ${t("tasks.detail.reviewerBadge")}` : name;
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
  step: {
    gap: theme.spacing[1],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  stepError: {
    color: theme.colors.statusDanger,
    fontSize: theme.fontSize.xs,
  },
  stepRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  stepCopy: {
    flex: 1,
    gap: theme.spacing[1],
  },
  stepName: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  stepStatus: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  stepBrief: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  stepMeta: {
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
    paddingHorizontal: theme.spacing[4],
    paddingTop: theme.spacing[2],
    paddingBottom: theme.spacing[4],
  },
  brief: {
    gap: theme.spacing[2],
  },
  titleInput: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.medium,
    paddingHorizontal: 0,
    paddingVertical: theme.spacing[1],
  },
  descriptionInput: {
    minHeight: 72,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    lineHeight: 20,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface1,
  },
  fieldRow: {
    flexDirection: "row",
    gap: theme.spacing[4],
  },
  fieldValue: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
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
  sectionTitleRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: theme.spacing[3],
  },
  sectionTitleCopy: {
    flex: 1,
    gap: theme.spacing[1],
  },
  sectionHint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  automationSummary: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    lineHeight: 20,
  },
  sectionHeading: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    textTransform: "uppercase",
  },
  deliveryRow: {
    gap: theme.spacing[1],
  },
  deliveryStatus: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  deliveryBranch: {
    color: theme.colors.foregroundMuted,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
  },
  deliveryError: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.xs,
    lineHeight: 18,
  },
  agentRow: {
    alignItems: "flex-start",
  },
  policyGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  policyEditor: {
    gap: theme.spacing[2],
    paddingTop: theme.spacing[1],
  },
  policyEditorHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  policyItem: {
    width: 180,
    gap: theme.spacing[1],
    padding: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface1,
  },
  policyLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  policyValue: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  relationshipRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minHeight: 28,
  },
  relationshipLabel: {
    width: 72,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  relationshipValue: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  relationshipStatus: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    textTransform: "capitalize",
  },
  subtaskComposer: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  inlineInput: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface1,
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
