import { useCallback, useMemo, useRef, useState, type ReactElement } from "react";
import { Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight, ChevronUp, SendHorizontal } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { isWeb } from "@/constants/platform";
import { useIsCompactFormFactor } from "@/constants/layout";
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
import type { Step, StepInput, TaskWorkflow } from "@getpaseo/protocol/tasks/workflow";
import { AdaptiveModalSheet, AdaptiveTextInput } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { DropdownTrigger } from "@/components/ui/dropdown-trigger";
import { FormTextInput } from "@/components/ui/form-field";
import { Switch } from "@/components/ui/switch";
import { SettingsSection } from "@/screens/settings/settings-section";
import { settingsStyles } from "@/styles/settings";
import { ICON_SIZE, SPACING, type Theme } from "@/styles/theme";
import { useToast } from "@/contexts/toast-context";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { useWorkspace } from "@/stores/session-store-hooks";
import { useSessionStore } from "@/stores/session-store";
import { formatTaskKey, selectBlockers, type TaskDependencyEdge } from "@/tasks/task-views";
import {
  AGGREGATE_WORK_REFUSAL,
  applyReviewMode,
  canCreateSubtask,
  EMPTY_SUBTASK_DRAFT,
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
  useTaskLabelDeletionSupported,
  useTaskMessagesSupported,
  useTaskMutations,
} from "@/tasks/use-tasks";
import { toErrorMessage } from "@/utils/error-messages";
import { BoardFeedEntryRow } from "./board-feed-entry";
import { activityFeedShowsHeader, groupActivityFeedEntries } from "./board-feed-entry.logic";
import { TaskExecutionStateDot } from "./task-execution-summary";
import { TASK_STATUS_LABEL_KEYS } from "./task-board-parts";
import {
  TaskDueDateChip,
  TaskLabelsChip,
  TaskPriorityChip,
  TaskStatusChip,
} from "./task-property-chips";
import {
  canStartTaskReview,
  groupTaskExecutionsByWorkspace,
  TASK_EXECUTION_STATE_LABELS,
  type TaskExecutionEntry,
  type TaskExecutionSummary,
  type TaskExecutionWorkspaceGroup,
} from "@/tasks/task-execution";
import { resolveProviderLabel } from "@/tasks/use-task-available-providers";

type TaskDetailTab = "execution" | "details" | "activity";

/** The body a sub-surface replaces on compact: a step's own screen or the
 * automation & delivery screen, reached with a back arrow (wireframe 1d). */
type TaskDetailSubSurface = { kind: "automation" } | { kind: "step"; stepId: string };

const ThemedChevronRight = withUnistyles(ChevronRight);
const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronUp = withUnistyles(ChevronUp);

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
    createLabel,
    deleteLabel,
    setStatus,
    setPriority,
    reviewTask,
    startReview,
    updateTask,
    createTask,
    setWorkflow,
    isReviewing,
    isBusy,
  } = useTaskMutations(serverId);
  const supportsLabelDeletion = useTaskLabelDeletionSupported(serverId);
  const isCompact = useIsCompactFormFactor();
  const [subSurface, setSubSurface] = useState<TaskDetailSubSurface | null>(null);
  const closeSubSurface = useCallback(() => setSubSurface(null), []);
  const openAutomationSurface = useCallback(() => setSubSurface({ kind: "automation" }), []);
  const openStepSurface = useCallback(
    (stepId: string) => setSubSurface({ kind: "step", stepId }),
    [],
  );
  const [isAutomationExpanded, setIsAutomationExpanded] = useState(false);
  const toggleAutomationExpanded = useCallback(
    () => setIsAutomationExpanded((current) => !current),
    [],
  );
  const { entries } = useBoardFeed({ serverId, projectId: task.projectId });
  const { post, sendMessage, isPosting } = useBoardFeedComposer({
    serverId,
    projectId: task.projectId,
  });
  const supportsMessages = useTaskMessagesSupported(serverId);
  const [activeTab, setActiveTab] = useState<TaskDetailTab>("execution");
  const [noteDraft, setNoteDraft] = useState("");
  const [reviewFeedback, setReviewFeedback] = useState("");
  // The brief inputs remount on external edits (their resetKey is the server
  // value), so the parallel drafts must follow — a stale draft would win the
  // comparison in saveBrief and silently revert the concurrent edit on blur.
  const [titleDraft, setTitleDraft] = useServerSyncedDraft(task.title, Object.is);
  const [descriptionDraft, setDescriptionDraft] = useServerSyncedDraft(task.description, Object.is);
  const [subtaskDraft, setSubtaskDraft] = useState<SubtaskDraft>(EMPTY_SUBTASK_DRAFT);
  const [noteResetKey, setNoteResetKey] = useState(0);
  const [subtaskResetKey, setSubtaskResetKey] = useState(0);
  const [isTitleFocused, setIsTitleFocused] = useState(false);
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

  const projectLabels = useMemo(
    () => labels.filter((label) => label.projectId === task.projectId),
    [labels, task.projectId],
  );
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
  const handleSetDueDate = useCallback(
    (dueDate: string | null) => updateTask({ taskId: task.id, dueDate }),
    [task.id, updateTask],
  );
  // Label toggles keep a local draft so checks in the open menu answer the
  // press immediately; the write rolls the draft back when the host refuses,
  // and a content change arriving from the server re-derives it.
  const [labelIdsDraft, setLabelIdsDraft] = useServerSyncedDraft<readonly string[]>(
    task.labelIds,
    sameStringArrays,
  );
  const handleSetLabelIds = useCallback(
    (labelIds: string[]) => {
      const previous = labelIdsDraft;
      setLabelIdsDraft(labelIds);
      return updateTask({ taskId: task.id, labelIds }).catch((error: unknown) => {
        setLabelIdsDraft(previous);
        throw error;
      });
    },
    [labelIdsDraft, setLabelIdsDraft, task.id, updateTask],
  );
  /** Rewrites the saved plan with one step's brief changed; `existingStepId`
   * keeps every step's identity and run history intact. */
  const saveStepBrief = useCallback(
    (stepId: string, prompt: string) => {
      if (!workflow) return;
      const trimmed = prompt.trim();
      if (!trimmed) return;
      const steps: StepInput[] = workflow.steps.map((step) => {
        const { id, runs: _runs, ...definition } = step;
        return {
          ...definition,
          existingStepId: id,
          prompt: id === stepId ? trimmed : definition.prompt,
        };
      });
      void setWorkflow({ taskId: task.id, steps }).catch((error) => {
        toast.show(toErrorMessage(error));
      });
    },
    [setWorkflow, task.id, toast, workflow],
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
  const focusTitle = useCallback(() => setIsTitleFocused(true), []);
  const blurTitle = useCallback(() => {
    setIsTitleFocused(false);
    saveBrief();
  }, [saveBrief]);

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
  const steps = workflow?.steps ?? [];
  const { surfaceStep, surfaceStepIndex } = resolveSurfaceStep(subSurface, steps);
  const header = useMemo(() => {
    if (subSurface) {
      let title = "Step";
      if (subSurface.kind === "automation") {
        title = "Automation & delivery";
      } else if (surfaceStep) {
        title = `Step ${surfaceStepIndex + 1} · ${surfaceStep.name}`;
      }
      return { title, back: { onPress: closeSubSurface } };
    }
    return {
      title: task.title,
      titleContent: <Text style={styles.taskKey}>{taskKey}</Text>,
      after: (
        <TaskDetailHeaderBody
          task={task}
          isCompact={isCompact}
          isTitleFocused={isTitleFocused}
          onTitleChange={setTitleDraft}
          onTitleFocus={focusTitle}
          onTitleBlur={blurTitle}
          onTitleSave={saveBrief}
          projectLabels={projectLabels}
          selectedLabelIds={labelIdsDraft}
          supportsLabelDeletion={supportsLabelDeletion}
          onSelectStatus={handleSelectStatus}
          onSelectPriority={handleSelectPriority}
          onSetDueDate={handleSetDueDate}
          onSetLabelIds={handleSetLabelIds}
          onCreateLabel={createLabel}
          onDeleteLabel={deleteLabel}
          presets={presets}
          isAggregate={isAggregate}
          startDisabled={blockers.length > 0 || isDelegating}
          onStart={handleDelegate}
          stepCount={steps.length}
          activityCount={comments.length}
          activeTab={activeTab}
          onSelectTab={setActiveTab}
        />
      ),
    };
  }, [
    activeTab,
    blockers.length,
    closeSubSurface,
    comments.length,
    createLabel,
    deleteLabel,
    handleDelegate,
    handleSelectPriority,
    handleSelectStatus,
    handleSetDueDate,
    handleSetLabelIds,
    blurTitle,
    focusTitle,
    isAggregate,
    isCompact,
    isDelegating,
    isTitleFocused,
    labelIdsDraft,
    presets,
    projectLabels,
    saveBrief,
    setTitleDraft,
    steps.length,
    subSurface,
    surfaceStep,
    surfaceStepIndex,
    task,
    taskKey,
    supportsLabelDeletion,
  ]);
  // The composer belongs to the conversation, so it only shows with it; on the
  // other tabs a compact layout uses the footer for the one primary action.
  const footer = useMemo(() => {
    if (subSurface) {
      return undefined;
    }
    if (activeTab === "activity") {
      return (
        <TaskUnifiedComposer
          serverId={serverId}
          task={task}
          supportsMessages={supportsMessages}
          noteDraft={noteDraft}
          noteResetKey={noteResetKey}
          isPosting={isPosting}
          onNoteChange={setNoteDraft}
          onSubmitNote={submitNote}
          sendMessage={sendMessage}
        />
      );
    }
    if (isCompact && presets.length > 0 && !isAggregate) {
      return (
        <View style={styles.startFooter}>
          <TaskStartControl
            presets={presets}
            isAggregate={isAggregate}
            disabled={blockers.length > 0 || isDelegating}
            onStart={handleDelegate}
          />
        </View>
      );
    }
    return undefined;
  }, [
    activeTab,
    blockers.length,
    handleDelegate,
    isAggregate,
    isCompact,
    isDelegating,
    isPosting,
    noteDraft,
    noteResetKey,
    presets,
    sendMessage,
    serverId,
    subSurface,
    submitNote,
    supportsMessages,
    task,
  ]);

  const automationSummary = resolveAutomationSummary(task, project, isAggregate);

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
      {subSurface ? (
        <TaskDetailSubSurfaceBody
          subSurface={subSurface}
          surfaceStep={surfaceStep}
          serverId={serverId}
          task={task}
          project={project}
          presets={presets}
          isAggregate={isAggregate}
          isActing={isActing}
          onAct={handleStepAction}
          onOpenAgent={handleOpenAgent}
          onSaveBrief={saveStepBrief}
        />
      ) : null}

      {!subSurface && activeTab === "execution" ? (
        <View style={styles.tabContent} testID="task-detail-execution-tab">
          <TaskDetailAttentionSection
            task={task}
            blockers={blockers}
            projectsById={projectsById}
            canArmReview={canArmReview}
            isReviewing={isReviewing}
            onFeedbackChange={setReviewFeedback}
            onApprove={handleApprove}
            onReject={handleReject}
            onStartReview={handleStartReview}
          />
          <TaskPlanSection
            workflow={workflow}
            isAggregate={isAggregate}
            isActing={isActing}
            isCompact={isCompact}
            automationSummary={automationSummary}
            isAutomationExpanded={isAutomationExpanded}
            onChangeAutomation={isCompact ? openAutomationSurface : toggleAutomationExpanded}
            onEdit={handleEditWorkflow}
            onAct={handleStepAction}
            onOpenAgent={handleOpenAgent}
            onOpenStep={openStepSurface}
            onSaveBrief={saveStepBrief}
          />
          {!isCompact && isAutomationExpanded ? (
            <View style={styles.groupContent} testID="task-detail-automation-expanded">
              <TaskAutomationSection
                serverId={serverId}
                task={task}
                project={project}
                presets={presets}
                hasSubtasks={isAggregate}
              />
              <TaskDeliverySection task={task} />
            </View>
          ) : null}
          <TaskAgentsSection groups={executionGroups} onOpenAgent={handleOpenAgent} />
          {subtasks.length > 0 || isAggregate ? (
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
          ) : null}
        </View>
      ) : null}

      {!subSurface && activeTab === "details" ? (
        <View style={styles.tabContent} testID="task-detail-details-tab">
          <TaskOverview task={task} onDescriptionChange={setDescriptionDraft} onSave={saveBrief} />
          <View style={styles.groupContent} testID="task-detail-details-group">
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
          </View>
        </View>
      ) : null}

      {!subSurface && activeTab === "activity" ? (
        <View style={styles.tabContent} testID="task-detail-activity-tab">
          <TaskUpdatesSection comments={comments} serverId={serverId} />
        </View>
      ) : null}
    </AdaptiveModalSheet>
  );
}

function sameStringArrays(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * Local draft state that re-derives from the server value when it changes —
 * an edit made on another client must not lose to a draft seeded at open time.
 * The adjustment happens during render (the React "adjusting state when props
 * change" pattern), so the stale draft never paints.
 */
function useServerSyncedDraft<T>(
  serverValue: T,
  isEqual: (a: T, b: T) => boolean,
): [T, (value: T) => void] {
  const [draft, setDraft] = useState(serverValue);
  const serverValueRef = useRef(serverValue);
  if (!isEqual(serverValueRef.current, serverValue)) {
    serverValueRef.current = serverValue;
    setDraft(serverValue);
  }
  return [draft, setDraft];
}

function resolveSurfaceStep(
  subSurface: TaskDetailSubSurface | null,
  steps: readonly Step[],
): { surfaceStep: Step | undefined; surfaceStepIndex: number } {
  if (subSurface?.kind !== "step") {
    return { surfaceStep: undefined, surfaceStepIndex: -1 };
  }
  const surfaceStepIndex = steps.findIndex((step) => step.id === subSurface.stepId);
  return {
    surfaceStep: surfaceStepIndex >= 0 ? steps[surfaceStepIndex] : undefined,
    surfaceStepIndex,
  };
}

/** The one automation line: the delivery branch when there is one, otherwise
 * the effective policy compressed to workspace · review. */
function resolveAutomationSummary(
  task: Task,
  project: TaskProject | undefined,
  isAggregate: boolean,
): string {
  if (task.integration?.branch) {
    return task.integration.branch;
  }
  const effectivePolicy = resolveTaskExecutionPolicy(project?.board, task.executionPolicy);
  const reviewMode = isAggregate ? resolveReviewMode(task.executionPolicy ?? {}) : null;
  return formatCompactAutomationSummary(effectivePolicy, reviewMode);
}

/** The stacked screen a sub-surface replaces the tab body with. */
function TaskDetailSubSurfaceBody({
  subSurface,
  surfaceStep,
  serverId,
  task,
  project,
  presets,
  isAggregate,
  isActing,
  onAct,
  onOpenAgent,
  onSaveBrief,
}: {
  subSurface: TaskDetailSubSurface;
  surfaceStep: Step | undefined;
  serverId: string;
  task: Task;
  project: TaskProject | undefined;
  presets: readonly TaskPreset[];
  isAggregate: boolean;
  isActing: boolean;
  onAct: (stepId: string, action: TaskStepAction) => void;
  onOpenAgent: (input: { workspaceId: string; agentId: string }) => void;
  onSaveBrief: (stepId: string, prompt: string) => void;
}): ReactElement {
  return (
    <View style={styles.tabContent} testID="task-detail-sub-surface">
      {subSurface.kind === "automation" ? (
        <>
          <TaskAutomationSection
            serverId={serverId}
            task={task}
            project={project}
            presets={presets}
            hasSubtasks={isAggregate}
          />
          <TaskDeliverySection task={task} />
        </>
      ) : null}
      {subSurface.kind === "step" && surfaceStep ? (
        <TaskStepSurface
          step={surfaceStep}
          disabled={isActing || isAggregate}
          onAct={onAct}
          onOpenAgent={onOpenAgent}
          onSaveBrief={onSaveBrief}
        />
      ) : null}
      {subSurface.kind === "step" && !surfaceStep ? (
        <Text style={styles.emptyComments} testID="task-detail-step-surface-missing">
          This step is no longer in the plan
        </Text>
      ) : null}
    </View>
  );
}

/** What needs a person first: the review verdict and the blockers, above the
 * plan when either applies. */
function TaskDetailAttentionSection({
  task,
  blockers,
  projectsById,
  canArmReview,
  isReviewing,
  onFeedbackChange,
  onApprove,
  onReject,
  onStartReview,
}: {
  task: Task;
  blockers: readonly Task[];
  projectsById: ReadonlyMap<string, TaskProject>;
  canArmReview: boolean;
  isReviewing: boolean;
  onFeedbackChange: (feedback: string) => void;
  onApprove: () => void;
  onReject: () => void;
  onStartReview: () => void;
}): ReactElement | null {
  if (task.status !== "in_review" && blockers.length === 0) {
    return null;
  }
  return (
    <View style={styles.groupContent} testID="task-detail-attention">
      {task.status === "in_review" ? (
        <TaskReviewSection
          iteration={task.reviewIteration}
          canStartReview={canArmReview}
          isReviewing={isReviewing}
          onFeedbackChange={onFeedbackChange}
          onApprove={onApprove}
          onReject={onReject}
          onStartReview={onStartReview}
        />
      ) : null}
      {blockers.length > 0 ? (
        <TaskBlockersSection blockers={blockers} projectsById={projectsById} />
      ) : null}
    </View>
  );
}

/** The header below the key row: full-width editable title, the property chip
 * rail, and the tab bar — one surface for identity and properties. */
function TaskDetailHeaderBody({
  task,
  isCompact,
  isTitleFocused,
  onTitleChange,
  onTitleFocus,
  onTitleBlur,
  onTitleSave,
  projectLabels,
  selectedLabelIds,
  supportsLabelDeletion,
  onSelectStatus,
  onSelectPriority,
  onSetDueDate,
  onSetLabelIds,
  onCreateLabel,
  onDeleteLabel,
  presets,
  isAggregate,
  startDisabled,
  onStart,
  stepCount,
  activityCount,
  activeTab,
  onSelectTab,
}: {
  task: Task;
  isCompact: boolean;
  isTitleFocused: boolean;
  onTitleChange: (title: string) => void;
  onTitleFocus: () => void;
  onTitleBlur: () => void;
  onTitleSave: () => void;
  projectLabels: readonly TaskLabel[];
  selectedLabelIds: readonly string[];
  supportsLabelDeletion: boolean;
  onSelectStatus: (status: TaskStatus) => void;
  onSelectPriority: (priority: TaskPriority) => void;
  onSetDueDate: (dueDate: string | null) => Promise<Task>;
  onSetLabelIds: (labelIds: string[]) => Promise<Task>;
  onCreateLabel: (input: { projectId: string; name: string; color: string }) => Promise<string>;
  onDeleteLabel: (labelId: string) => Promise<void>;
  presets: readonly TaskPreset[];
  isAggregate: boolean;
  startDisabled: boolean;
  onStart: (presetId: string) => void;
  stepCount: number;
  activityCount: number;
  activeTab: TaskDetailTab;
  onSelectTab: (tab: TaskDetailTab) => void;
}): ReactElement {
  return (
    <View style={styles.headerBody}>
      <View style={styles.headerTitleBlock}>
        <AdaptiveTextInput
          initialValue={task.title}
          resetKey={task.title}
          onChangeText={onTitleChange}
          onFocus={onTitleFocus}
          onBlur={onTitleBlur}
          onEndEditing={onTitleSave}
          placeholder="What needs to be done?"
          style={[
            styles.headerTitleInput,
            isTitleFocused ? styles.headerTitleInputFocused : null,
            isWeb ? { outlineWidth: 0, outlineColor: "transparent" } : null,
          ]}
          testID="task-detail-title-input"
        />
      </View>
      <View style={styles.chipRow}>
        <TaskStatusChip
          status={task.status}
          onSelect={onSelectStatus}
          testID="task-detail-status-trigger"
        />
        <TaskPriorityChip
          priority={task.priority}
          onSelect={onSelectPriority}
          testID="task-detail-priority-trigger"
        />
        <TaskDueDateChip
          dueDate={task.dueDate}
          onSetDueDate={onSetDueDate}
          testID="task-detail-due-trigger"
        />
        <TaskLabelsChip
          projectId={task.projectId}
          projectLabels={projectLabels}
          selectedLabelIds={selectedLabelIds}
          supportsDeletion={supportsLabelDeletion}
          onSetLabelIds={onSetLabelIds}
          onCreateLabel={onCreateLabel}
          onDeleteLabel={onDeleteLabel}
          testID="task-detail-labels-trigger"
        />
        {isCompact ? null : (
          <View style={styles.chipRowTrailing}>
            <TaskStartControl
              presets={presets}
              isAggregate={isAggregate}
              disabled={startDisabled}
              onStart={onStart}
            />
          </View>
        )}
      </View>
      <View style={styles.tabBar} accessibilityRole="tablist">
        <TaskDetailTabButton
          tab="execution"
          label="Execution"
          count={stepCount}
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
          count={activityCount}
          activeTab={activeTab}
          onSelect={onSelectTab}
        />
      </View>
    </View>
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

function TaskDetailTabButton({
  tab,
  label,
  count,
  activeTab,
  onSelect,
}: {
  tab: TaskDetailTab;
  label: string;
  /** Shown beside the label when there is something to count. */
  count?: number;
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
      hitSlop={SPACING[1]}
      style={[styles.tab, active ? styles.tabActive : null]}
      testID={`task-detail-tab-${tab}`}
    >
      <View style={styles.tabInner}>
        <Text style={[styles.tabLabel, active ? styles.tabLabelActive : null]}>{label}</Text>
        {count ? <Text style={styles.tabCount}>{count}</Text> : null}
      </View>
    </Pressable>
  );
}

type TaskComposerMode = "instruction" | "note";

function TaskUnifiedComposer({
  serverId,
  task,
  supportsMessages,
  noteDraft,
  noteResetKey,
  isPosting,
  onNoteChange,
  onSubmitNote,
  sendMessage,
}: {
  serverId: string;
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
  const [selectedRecipientAgentIds, setSelectedRecipientAgentIds] = useState<Set<string>>(
    () => new Set(task.agents.map((agent) => agent.agentId)),
  );
  const recipientAgentIds = useMemo(
    () =>
      task.agents
        .map((agent) => agent.agentId)
        .filter((agentId) => selectedRecipientAgentIds.has(agentId)),
    [selectedRecipientAgentIds, task.agents],
  );
  const activeMode = mode === "instruction" && canInstruct ? "instruction" : "note";
  const useInstruction = useCallback(() => setMode("instruction"), []);
  const useNote = useCallback(() => setMode("note"), []);
  const toggleRecipient = useCallback((agentId: string) => {
    setSelectedRecipientAgentIds((current) => {
      const next = new Set(current);
      if (next.has(agentId)) {
        next.delete(agentId);
      } else {
        next.add(agentId);
      }
      return next;
    });
  }, []);
  const submitInstruction = useCallback(() => {
    const body = instructionDraft.trim();
    if (!body || !canInstruct || recipientAgentIds.length === 0 || isPosting) return;
    setInstructionDraft("");
    setInstructionResetKey((current) => current + 1);
    void sendMessage({
      body,
      taskId: task.id,
      recipientAgentIds,
    }).catch((error) => {
      setInstructionDraft(body);
      setInstructionResetKey((current) => current + 1);
      toast.show(toErrorMessage(error));
    });
  }, [canInstruct, instructionDraft, isPosting, recipientAgentIds, sendMessage, task.id, toast]);
  const submit = activeMode === "instruction" ? submitInstruction : onSubmitNote;
  const draft = activeMode === "instruction" ? instructionDraft : noteDraft;
  const resetKey = activeMode === "instruction" ? instructionResetKey : noteResetKey;
  const onChange = activeMode === "instruction" ? setInstructionDraft : onNoteChange;
  const recipientSummary =
    recipientAgentIds.length === task.agents.length
      ? "All agents"
      : `${recipientAgentIds.length} of ${task.agents.length} agents`;

  return (
    <View style={styles.unifiedComposer} testID="task-detail-unified-composer">
      <View style={styles.composerModeRow}>
        <Button
          variant={activeMode === "instruction" ? "secondary" : "ghost"}
          size="xs"
          onPress={useInstruction}
          disabled={!canInstruct}
          testID="task-detail-composer-instruction"
        >
          Agent instruction
        </Button>
        <Button
          variant={activeMode === "note" ? "secondary" : "ghost"}
          size="xs"
          onPress={useNote}
          testID="task-detail-composer-note"
        >
          Internal note
        </Button>
        {activeMode === "instruction" ? (
          <View style={styles.composerRecipientMenu}>
            <DropdownMenu>
              <DropdownTrigger testID="task-detail-composer-recipients">
                <Text style={styles.composerRecipientSummary}>{recipientSummary}</Text>
              </DropdownTrigger>
              <DropdownMenuContent align="end">
                {task.agents.map((agent) => (
                  <TaskRecipientMenuItem
                    key={agent.agentId}
                    serverId={serverId}
                    agentId={agent.agentId}
                    workspaceId={agent.workspaceId}
                    selected={selectedRecipientAgentIds.has(agent.agentId)}
                    onToggle={toggleRecipient}
                  />
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </View>
        ) : null}
      </View>
      <View style={styles.composerInputRow}>
        <View style={styles.fieldFill}>
          <FormTextInput
            initialValue={draft}
            resetKey={`${activeMode}-${resetKey}`}
            onChangeText={onChange}
            onSubmitEditing={submit}
            placeholder={
              activeMode === "instruction" ? "Instruct the agent..." : "Write an internal note..."
            }
            multiline
            testID={`task-detail-${activeMode}-input`}
          />
        </View>
        <Button
          variant="secondary"
          size="sm"
          leftIcon={SendHorizontal}
          onPress={submit}
          disabled={
            !draft.trim() ||
            isPosting ||
            (activeMode === "instruction" && (!canInstruct || recipientAgentIds.length === 0))
          }
          testID={`task-detail-${activeMode}-send`}
        >
          Send
        </Button>
      </View>
    </View>
  );
}

function TaskRecipientMenuItem({
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
  const name = agent?.title ?? workspace?.title ?? workspace?.name ?? agent?.provider ?? "Agent";
  const handleSelect = useCallback(() => onToggle(agentId), [agentId, onToggle]);
  return (
    <DropdownMenuItem
      selected={selected}
      showSelectedCheck
      closeOnSelect={false}
      onSelect={handleSelect}
      testID={`task-detail-composer-recipient-${agentId}`}
    >
      {name}
    </DropdownMenuItem>
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
    <SettingsSection title="Task description" flush testID="task-detail-brief">
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
    </SettingsSection>
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

/** The automation policy as one short line, stated once per surface. */
function formatCompactAutomationSummary(
  effective: ReturnType<typeof resolveTaskExecutionPolicy>,
  reviewMode: ReviewMode | null,
): string {
  let workspace = "Preset workspace";
  if (effective.workspace === "dedicated") {
    workspace = "Dedicated worktrees";
  } else if (effective.workspace === "reuse") {
    workspace = "Task workspace";
  }
  if (reviewMode) {
    return `${workspace} · ${REVIEW_MODE_LABELS[reviewMode]}`;
  }
  const review = effective.reviewEnabled ? `review ×${effective.maxReviewIterations}` : "no review";
  return `${workspace} · ${review}`;
}

/**
 * The task's saved plan as one card of rows. On an aggregate the plan is
 * refused rather than hidden: the steps of one authored before the subtasks
 * existed stay readable, with their run history, but nothing new can be
 * authored on a card that holds no workers. Automation is stated once — the
 * compact line beside the section title on desktop, a drill-in row on compact.
 */
function TaskPlanSection({
  workflow,
  isAggregate,
  isActing,
  isCompact,
  automationSummary,
  isAutomationExpanded,
  onChangeAutomation,
  onEdit,
  onAct,
  onOpenAgent,
  onOpenStep,
  onSaveBrief,
}: {
  workflow: TaskWorkflow | null;
  isAggregate: boolean;
  isActing: boolean;
  isCompact: boolean;
  automationSummary: string;
  isAutomationExpanded: boolean;
  onChangeAutomation: () => void;
  onEdit: () => void;
  onAct: (stepId: string, action: TaskStepAction) => void;
  onOpenAgent: (input: { workspaceId: string; agentId: string }) => void;
  onOpenStep: (stepId: string) => void;
  onSaveBrief: (stepId: string, prompt: string) => void;
}): ReactElement {
  const steps = workflow?.steps ?? [];
  const trailing = useMemo(
    () =>
      isCompact ? null : (
        <View style={styles.planTrailing}>
          <Text style={styles.planAutomationSummary} numberOfLines={1}>
            {automationSummary}
          </Text>
          <Button
            variant="ghost"
            size="xs"
            onPress={onChangeAutomation}
            testID="task-detail-automation-change"
          >
            {isAutomationExpanded ? "Done" : "Change"}
          </Button>
        </View>
      ),
    [automationSummary, isAutomationExpanded, isCompact, onChangeAutomation],
  );
  return (
    <SettingsSection title="Plan" flush testID="task-detail-workflow" trailing={trailing}>
      {isAggregate ? <Text style={settingsStyles.rowHint}>{AGGREGATE_WORK_REFUSAL}</Text> : null}
      {steps.length > 0 ? (
        <View style={settingsStyles.card}>
          {steps.map((step, index) => (
            <PlanStepRow
              key={step.id}
              step={step}
              index={index}
              withBorder={index > 0}
              disabled={isActing || isAggregate}
              isCompact={isCompact}
              onAct={onAct}
              onOpenAgent={onOpenAgent}
              onOpenStep={onOpenStep}
              onSaveBrief={onSaveBrief}
            />
          ))}
          {isAggregate ? null : (
            <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
              <Button variant="ghost" size="sm" onPress={onEdit} testID="task-detail-workflow-edit">
                Add step
              </Button>
            </View>
          )}
        </View>
      ) : null}
      {steps.length > 0 || isAggregate ? null : (
        <View style={styles.planEmpty}>
          <Text style={styles.emptyComments}>
            No saved plan. Start from a preset, or add a multi-step agent plan.
          </Text>
          <Button variant="ghost" size="sm" onPress={onEdit} testID="task-detail-workflow-edit">
            Add plan
          </Button>
        </View>
      )}
      {isCompact ? (
        <View style={settingsStyles.card}>
          <Pressable
            onPress={onChangeAutomation}
            accessibilityRole="button"
            style={settingsStyles.row}
            testID="task-detail-automation-open"
          >
            <View style={settingsStyles.rowContent}>
              <Text style={settingsStyles.rowTitle}>Automation & delivery</Text>
              <Text style={settingsStyles.rowHint} numberOfLines={1}>
                {automationSummary}
              </Text>
            </View>
            <ThemedChevronRight size={ICON_SIZE.sm} uniProps={mutedIconMapping} />
          </Pressable>
        </View>
      ) : null}
    </SettingsSection>
  );
}

/**
 * One plan step as a row: number, name, its agent once, and the one action its
 * last run allows. The brief expands in place on desktop and gets its own
 * screen on compact — read where you run, edit where you read.
 */
function PlanStepRow({
  step,
  index,
  withBorder,
  disabled,
  isCompact,
  onAct,
  onOpenAgent,
  onOpenStep,
  onSaveBrief,
}: {
  step: Step;
  index: number;
  withBorder: boolean;
  disabled: boolean;
  isCompact: boolean;
  onAct: (stepId: string, action: TaskStepAction) => void;
  onOpenAgent: (input: { workspaceId: string; agentId: string }) => void;
  onOpenStep: (stepId: string) => void;
  onSaveBrief: (stepId: string, prompt: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  const [isExpanded, setIsExpanded] = useState(false);
  const { status, actions, error } = resolveStepState(step);
  const primaryAction = actions.find((action) => action !== "skip");
  const hasSkip = actions.includes("skip");
  const agentTarget = resolveStepAgentTarget(step);
  const isActive = status === "running" || status === "queued";
  const isFailed = status === "failed" || status === "interrupted" || status === "canceled";
  const handlePress = useCallback(() => {
    if (isCompact) {
      onOpenStep(step.id);
      return;
    }
    setIsExpanded((current) => !current);
  }, [isCompact, onOpenStep, step.id]);
  const handleOpenAgent = useCallback(() => {
    if (agentTarget) onOpenAgent(agentTarget);
  }, [agentTarget, onOpenAgent]);
  const handleSkip = useCallback(() => onAct(step.id, "skip"), [onAct, step.id]);
  const accessibilityState = useMemo(
    () => (isCompact ? undefined : { expanded: isExpanded }),
    [isCompact, isExpanded],
  );
  return (
    <View
      style={withBorder ? settingsStyles.rowBorder : null}
      testID={`task-detail-step-${step.id}`}
    >
      <Pressable
        onPress={handlePress}
        accessibilityRole="button"
        accessibilityState={accessibilityState}
        accessibilityLabel={`Step ${index + 1}: ${step.name}`}
        style={[settingsStyles.row, styles.planStepRow]}
        testID={`task-detail-step-toggle-${step.id}`}
      >
        <View style={styles.stepIndexBadge}>
          <Text style={styles.stepIndexText}>{index + 1}</Text>
        </View>
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
          <Text style={styles.stepMeta}>
            {step.agents[0]?.model ?? step.agents[0]?.provider ?? "Agent"}
          </Text>
          {error ? (
            <Text style={settingsStyles.rowError} testID={`task-detail-step-${step.id}-error`}>
              {error}
            </Text>
          ) : null}
        </View>
        {primaryAction ? (
          <StepActionButton
            stepId={step.id}
            action={primaryAction}
            disabled={disabled}
            onAct={onAct}
          />
        ) : null}
        <PlanStepRowChevron isCompact={isCompact} isExpanded={isExpanded} />
      </Pressable>
      {!isCompact && isExpanded ? (
        <View style={styles.stepExpanded} testID={`task-detail-step-expanded-${step.id}`}>
          <StepBriefEditor step={step} editable={!disabled} onSaveBrief={onSaveBrief} />
          <View style={styles.stepExpandedFooter}>
            <Text style={styles.stepMeta}>{formatWorkspaceMode(step)}</Text>
            <View style={styles.actionRow}>
              {agentTarget ? (
                <Button
                  variant="ghost"
                  size="xs"
                  onPress={handleOpenAgent}
                  testID={`task-detail-step-chat-${step.id}`}
                >
                  Open agent
                </Button>
              ) : null}
              {hasSkip ? (
                <Button
                  variant="ghost"
                  size="xs"
                  onPress={handleSkip}
                  disabled={disabled}
                  testID={`task-detail-step-${step.id}-skip`}
                >
                  {t("tasks.detail.stepAction.skip")}
                </Button>
              ) : null}
            </View>
          </View>
        </View>
      ) : null}
    </View>
  );
}

function PlanStepRowChevron({
  isCompact,
  isExpanded,
}: {
  isCompact: boolean;
  isExpanded: boolean;
}): ReactElement {
  if (isCompact) {
    return <ThemedChevronRight size={ICON_SIZE.sm} uniProps={mutedIconMapping} />;
  }
  if (isExpanded) {
    return <ThemedChevronUp size={ICON_SIZE.sm} uniProps={mutedIconMapping} />;
  }
  return <ThemedChevronDown size={ICON_SIZE.sm} uniProps={mutedIconMapping} />;
}

/** The step's brief where it is read: saves on blur, only when it changed. */
function StepBriefEditor({
  step,
  editable,
  onSaveBrief,
}: {
  step: Step;
  editable: boolean;
  onSaveBrief: (stepId: string, prompt: string) => void;
}): ReactElement {
  const [draft, setDraft] = useState(step.prompt);
  const save = useCallback(() => {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== step.prompt) {
      onSaveBrief(step.id, trimmed);
    }
  }, [draft, onSaveBrief, step.id, step.prompt]);
  return (
    <AdaptiveTextInput
      initialValue={step.prompt}
      resetKey={`${step.id}-${step.prompt}`}
      onChangeText={setDraft}
      onBlur={save}
      onEndEditing={save}
      editable={editable}
      placeholder="What should the agent do in this step?"
      style={styles.stepBriefInput}
      multiline
      testID={`task-detail-step-brief-${step.id}`}
    />
  );
}

/** A step's own screen on compact: the brief, the facts, and the actions the
 * last run allows — the same content the desktop row expands in place. */
function TaskStepSurface({
  step,
  disabled,
  onAct,
  onOpenAgent,
  onSaveBrief,
}: {
  step: Step;
  disabled: boolean;
  onAct: (stepId: string, action: TaskStepAction) => void;
  onOpenAgent: (input: { workspaceId: string; agentId: string }) => void;
  onSaveBrief: (stepId: string, prompt: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  const { status, actions, error } = resolveStepState(step);
  const primaryAction = actions.find((action) => action !== "skip");
  const hasSkip = actions.includes("skip");
  const agentTarget = resolveStepAgentTarget(step);
  const handleOpenAgent = useCallback(() => {
    if (agentTarget) onOpenAgent(agentTarget);
  }, [agentTarget, onOpenAgent]);
  const handlePrimary = useCallback(() => {
    if (primaryAction) onAct(step.id, primaryAction);
  }, [onAct, primaryAction, step.id]);
  const handleSkip = useCallback(() => onAct(step.id, "skip"), [onAct, step.id]);
  return (
    <View style={styles.groupContent} testID={`task-detail-step-surface-${step.id}`}>
      <SettingsSection title="Agent brief" flush>
        <StepBriefEditor step={step} editable={!disabled} onSaveBrief={onSaveBrief} />
      </SettingsSection>
      <View style={settingsStyles.card}>
        <View style={settingsStyles.row}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>Agent</Text>
          </View>
          <Text style={styles.policyValue}>
            {step.agents[0]?.model ?? step.agents[0]?.provider ?? "Agent"}
          </Text>
        </View>
        <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>Workspace</Text>
          </View>
          <Text style={styles.policyValue}>{formatWorkspaceMode(step)}</Text>
        </View>
        <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>Status</Text>
            {error ? <Text style={settingsStyles.rowError}>{error}</Text> : null}
          </View>
          <Text style={styles.policyValue}>{t(`tasks.detail.stepStatus.${status}`)}</Text>
        </View>
      </View>
      <View style={styles.actionRow}>
        {primaryAction ? (
          <Button
            variant="default"
            size="sm"
            onPress={handlePrimary}
            disabled={disabled}
            testID={`task-detail-step-${step.id}-${primaryAction}`}
          >
            {t(`tasks.detail.stepAction.${primaryAction}`)}
          </Button>
        ) : null}
        {hasSkip ? (
          <Button
            variant="outline"
            size="sm"
            onPress={handleSkip}
            disabled={disabled}
            testID={`task-detail-step-${step.id}-skip`}
          >
            {t("tasks.detail.stepAction.skip")}
          </Button>
        ) : null}
        {agentTarget ? (
          <Button
            variant="ghost"
            size="sm"
            onPress={handleOpenAgent}
            testID={`task-detail-step-chat-${step.id}`}
          >
            Open agent
          </Button>
        ) : null}
      </View>
    </View>
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
  const effectivePolicy = resolveTaskExecutionPolicy(project?.board, policy);
  const reviewMode = hasSubtasks ? resolveReviewMode(policy) : null;
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

  const canReset = Object.keys(policy).length > 0;
  const trailing = useMemo(
    () =>
      supportsExecutionPolicy && canReset ? (
        <Button
          variant="ghost"
          size="sm"
          onPress={resetPolicy}
          testID="task-detail-automation-reset"
        >
          Use defaults
        </Button>
      ) : null,
    [canReset, resetPolicy, supportsExecutionPolicy],
  );

  return (
    <SettingsSection title="Automation" flush trailing={trailing} testID="task-detail-automation">
      {supportsExecutionPolicy ? (
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
    lineHeight: 16,
  },
  headerBody: {
    gap: theme.spacing[3],
  },
  headerTitleBlock: {
    paddingHorizontal: theme.spacing[6],
  },
  headerTitleInput: {
    width: "100%",
    minWidth: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.medium,
    lineHeight: 24,
    textAlign: "left",
    paddingVertical: 0,
    paddingBottom: theme.spacing[0.5],
    borderBottomWidth: 1,
    borderBottomColor: "transparent",
  },
  headerTitleInputFocused: {
    borderBottomColor: theme.colors.accentBright,
  },
  chipRow: {
    paddingHorizontal: theme.spacing[6],
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[1.5],
  },
  chipRowTrailing: {
    marginLeft: "auto",
  },
  startFooter: {
    flex: 1,
    alignItems: "stretch",
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
  },
  tabContent: {
    gap: theme.spacing[6],
  },
  tabInner: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: theme.spacing[1.5],
  },
  tabCount: {
    color: theme.colors.foregroundMuted,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
  },
  planTrailing: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    minWidth: 0,
    flexShrink: 1,
  },
  planAutomationSummary: {
    flexShrink: 1,
    minWidth: 0,
    color: theme.colors.foregroundMuted,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
  },
  planEmpty: {
    gap: theme.spacing[2],
    alignItems: "flex-start",
  },
  planStepRow: {
    gap: theme.spacing[2],
  },
  stepIndexBadge: {
    width: 20,
    height: 20,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.full,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
  },
  stepIndexText: {
    color: theme.colors.foregroundMuted,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
    lineHeight: 14,
  },
  stepExpanded: {
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    paddingBottom: theme.spacing[4],
  },
  stepExpandedFooter: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  stepBriefInput: {
    minHeight: 72,
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
    fontSize: theme.fontSize.sm,
    lineHeight: 20,
    padding: theme.spacing[3],
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
  actionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
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
  composerRecipientMenu: {
    marginLeft: "auto",
  },
  composerRecipientSummary: {
    color: theme.colors.foregroundMuted,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
  },
  composerInputRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: theme.spacing[2],
  },
}));
