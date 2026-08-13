import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactElement,
  type ReactNode,
} from "react";
import {
  Pressable,
  ScrollView,
  Text,
  View,
  type NativeSyntheticEvent,
  type TextLayoutEventData,
} from "react-native";
import { useTranslation } from "react-i18next";
import {
  Archive,
  Check,
  CircleAlert,
  CircleX,
  ChevronDown,
  ChevronUp,
  ChevronRight,
  Clock,
  CornerUpLeft,
  Eye,
  GitBranch,
  ListTree,
  MoreHorizontal,
  Play,
  Plus,
  SendHorizontal,
} from "lucide-react-native";
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
import type {
  Step,
  StepAgentSpec,
  StepInput,
  TaskWorkflow,
} from "@getpaseo/protocol/tasks/workflow";
import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import { formatThinkingOptionLabel } from "@/agent-controls/labels";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { AdaptiveModalSheet, AdaptiveTextInput } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { DropdownTrigger } from "@/components/ui/dropdown-trigger";
import { FormTextInput } from "@/components/ui/form-field";
import { Switch } from "@/components/ui/switch";
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
  withSubtaskTitle,
  type ReviewMode,
  type SubtaskDraft,
} from "@/tasks/task-aggregate";
import { useTaskDelegate, useTaskPresets } from "@/tasks/use-task-delegate";
import {
  resolveStepState,
  useTaskStepActions,
  type TaskStepAction,
  type TaskStepDisplayStatus,
} from "@/tasks/use-task-workflow";
import { resolveStepAgentTarget } from "@/tasks/task-workflow-view";
import { buildTaskWorkflowSteps } from "@/tasks/task-workflow-form-model";
import { useTaskWorkflowFormModel } from "@/tasks/use-task-workflow-form-model";
import { useKanbanProjectCwd } from "@/tasks/use-kanban-project-cwd";
import { TaskWorkflowStepEditor } from "./task-workflow-step-editor";
import { TASK_WORKFLOW_TRIGGER_LABEL_KEYS } from "@/tasks/task-workflow-form-model";
import { useBoardFeed, useBoardFeedComposer } from "@/tasks/use-board-feed";
import {
  useTaskExecutionPolicySupported,
  useTaskLabelDeletionSupported,
  useTaskMessagesSupported,
  useTaskMutations,
} from "@/tasks/use-tasks";
import { toErrorMessage } from "@/utils/error-messages";
import { formatCompactTimeAgo, formatDateStamp, formatDuration } from "@/utils/time";
import { BoardFeedEntryRow } from "./board-feed-entry";
import {
  resolveSubSurfaceTitle,
  resolveSurfaceStep,
  type TaskDetailSubSurface,
} from "./task-detail-sheet.logic";
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
  TASK_EXECUTION_LIVE_STATES,
  TASK_EXECUTION_STATE_LABELS,
  type TaskExecutionEntry,
  type TaskExecutionState,
  type TaskExecutionSummary,
  type TaskExecutionWorkspaceGroup,
} from "@/tasks/task-execution";
import { resolveProviderLabel } from "@/tasks/use-task-available-providers";

type TaskDetailTab = "execution" | "details" | "activity";

type TaskRelationKind = "parent" | "blocker";

/** What the task hangs off: its parent, or a task that has to settle first. */
interface TaskRelationship {
  kind: TaskRelationKind;
  label: string;
  task: Task;
}

/**
 * One block of the task surface: a 14px heading with an optional trailing
 * control, then its content. Local to this sheet because the task detail sets
 * its own density — settings screens keep theirs.
 */
function DetailSection({
  title,
  trailing,
  testID,
  children,
}: {
  title: string;
  trailing?: ReactNode;
  testID?: string;
  children: ReactNode;
}): ReactElement {
  return (
    <View style={styles.section} testID={testID}>
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>{title}</Text>
        {trailing}
      </View>
      {children}
    </View>
  );
}

/** The rail beside the tabs on desktop: properties, live agents, relations. */
const DETAIL_RAIL_WIDTH = 256;
/** The plan's right columns: each is fixed so durations and statuses line up
 * down the plan, while the model stays beside the time rather than being pushed
 * off by a short status. */
const STEP_DURATION_WIDTH = 48;
const STEP_STATUS_WIDTH = 56;
/** Rhythm and type the design fixes outside the token scales. */
const RAIL_GROUP_GAP = 20;
const DETAIL_TEXT_SIZE = 13;
const STEP_DURATION_FONT_SIZE = 11;
/** The automation grid: a row taller than a list row, so a settings screen of
 * one-line rows still breathes without a card around it. */
const POLICY_ROW_PADDING = 14;
/** A tab's own side padding widens its hit area and carries its underline past
 * the label. The bar pulls back by the same amount so the first label still
 * lands on the pane's content rail instead of sitting a few pixels inside it. */
const TAB_HIT_PADDING = SPACING[1];
/** The facts block: one label column, one line height, one rhythm. */
const META_LABEL_WIDTH = 96;
const META_LINE_HEIGHT = 18;
const TITLE_INPUT_TEST_ID = "task-detail-title-input";
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
/** The composer reads as one control: the field and its send button share a
 * height, as they do in the design. */
const COMPOSER_CONTROL_HEIGHT = 44;

/** The workspace strategies a step can be moved between from the plan. The
 * fourth, `existing`, names a checkout and is only authored in the editor. */

/** Keeps the rail's divider full height when the left pane is short. */
const DESKTOP_SPLIT_MIN_HEIGHT = 480;
const DESKTOP_MAX_WIDTH = 900;
const EMPTY_STEPS: readonly Step[] = [];

const ThemedChevronRight = withUnistyles(ChevronRight);
const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedClock = withUnistyles(Clock);
const ThemedEye = withUnistyles(Eye);
const ThemedMoreHorizontal = withUnistyles(MoreHorizontal);
const ThemedGitBranch = withUnistyles(GitBranch);
const ThemedArchive = withUnistyles(Archive);
const ThemedListTree = withUnistyles(ListTree);
const ThemedPlus = withUnistyles(Plus);
const ThemedCornerUpLeft = withUnistyles(CornerUpLeft);
const ThemedCheck = withUnistyles(Check);
const ThemedPlay = withUnistyles(Play);
const ThemedCircleAlert = withUnistyles(CircleAlert);
const ThemedCircleX = withUnistyles(CircleX);
const ThemedChevronUp = withUnistyles(ChevronUp);

const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const warningIconMapping = (theme: Theme) => ({ color: theme.colors.statusWarning });
const dangerIconMapping = (theme: Theme) => ({ color: theme.colors.statusDanger });
const extraMutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundExtraMuted });
const runningIconMapping = (theme: Theme) => ({ color: theme.colors.statusDotRunning });

export interface TaskDetailSheetProps {
  serverId: string;
  /** The Paseo project the board belongs to; the plan editor resolves provider
   * capabilities against its checkout. */
  paseoProjectId: string;
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
  /** Opens straight onto a sub-surface — capture's "Create & plan" lands on the
   * new task with its plan editor already up. */
  initialSubSurface?: TaskDetailSubSurface | null | undefined;
  /** Swaps the sheet onto another task — what a blocker or a relation opens. */
  onOpenTask?: ((taskId: string) => void) | undefined;
  /** Confirms and deletes on the host's terms; the sheet only asks. */
  onDeleteTask?: ((taskId: string) => void) | undefined;
  onClose: () => void;
}

/**
 * A press on a card always opens this: description, status, priority, labels,
 * due date, attached agents and the task's own comments. Replaces the old
 * single-agent chat shortcut, which had no rule a user could learn.
 */
export function TaskDetailSheet({
  serverId,
  paseoProjectId,
  taskId,
  tasks,
  labels,
  projectsById,
  dependencies,
  workflows,
  executionSummary,
  executionByTaskId,
  initialSubSurface,
  onOpenTask,
  onDeleteTask,
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
      paseoProjectId={paseoProjectId}
      task={task}
      project={projectsById.get(task.projectId)}
      projectsById={projectsById}
      tasks={tasks}
      dependencies={dependencies}
      workflow={workflows.find((entry) => entry.taskId === task.id) ?? null}
      executionSummary={executionSummary}
      executionByTaskId={executionByTaskId}
      initialSubSurface={initialSubSurface}
      labels={labels}
      onOpenTask={onOpenTask}
      onDeleteTask={onDeleteTask}
      onClose={onClose}
    />
  );
}

function OpenTaskDetailSheet({
  serverId,
  paseoProjectId,
  task,
  project,
  projectsById,
  tasks,
  dependencies,
  workflow,
  executionSummary,
  executionByTaskId,
  initialSubSurface,
  labels,
  onOpenTask,
  onDeleteTask,
  onClose,
}: {
  serverId: string;
  paseoProjectId: string;
  task: Task;
  project: TaskProject | undefined;
  projectsById: ReadonlyMap<string, TaskProject>;
  tasks: readonly Task[];
  dependencies: readonly TaskDependencyEdge[];
  workflow: TaskWorkflow | null;
  executionSummary?: TaskExecutionSummary | undefined;
  executionByTaskId?: ReadonlyMap<string, TaskExecutionSummary> | undefined;
  initialSubSurface?: TaskDetailSubSurface | null | undefined;
  labels: readonly TaskLabel[];
  onOpenTask?: ((taskId: string) => void) | undefined;
  onDeleteTask?: ((taskId: string) => void) | undefined;
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
  const [subSurface, setSubSurface] = useState<TaskDetailSubSurface | null>(
    initialSubSurface ?? null,
  );
  const closeSubSurface = useCallback(() => setSubSurface(null), []);
  const openAutomationSurface = useCallback(() => setSubSurface({ kind: "automation" }), []);
  const openPlanSurface = useCallback(() => setSubSurface({ kind: "plan" }), []);
  const openStepSurface = useCallback(
    (stepId: string) => setSubSurface({ kind: "step", stepId }),
    [],
  );
  // Esc, ✕, the backdrop and hardware back all arrive here: each closes the
  // innermost surface only, so a sub-surface is never the thing that dismisses
  // the task.
  const handleClose = useCallback(() => {
    if (subSurface) {
      closeSubSurface();
      return;
    }
    onClose();
  }, [closeSubSurface, onClose, subSurface]);
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
  const {
    draft: descriptionDraft,
    setDraft: setDescriptionDraft,
    resetKey: descriptionResetKey,
    markSent: markDescriptionSent,
  } = useEchoAwareDraft(task.description);
  const [subtaskDraft, setSubtaskDraft] = useState<SubtaskDraft>(EMPTY_SUBTASK_DRAFT);
  const [noteResetKey, setNoteResetKey] = useState(0);
  const [subtaskResetKey, setSubtaskResetKey] = useState(0);
  const [isTitleEditing, setIsTitleEditing] = useState(false);
  const [isSavingBrief, setIsSavingBrief] = useState(false);
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
  const relationships = useMemo<readonly TaskRelationship[]>(
    () => [
      ...(parent ? [{ kind: "parent" as const, label: "Parent", task: parent }] : []),
      ...dependenciesForTask.map((dependency) => ({
        kind: "blocker" as const,
        label: "Waits for",
        task: dependency,
      })),
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
  /** Rewrites the saved plan with one step changed; `existingStepId` keeps every
   * step's identity and run history intact. */

  const saveBrief = useCallback(() => {
    const title = titleDraft.trim();
    if (!title || (title === task.title && descriptionDraft === task.description)) {
      return;
    }
    setIsSavingBrief(true);
    markDescriptionSent(descriptionDraft);
    void updateTask({ taskId: task.id, title, description: descriptionDraft })
      .catch((error) => {
        toast.show(toErrorMessage(error));
      })
      .finally(() => setIsSavingBrief(false));
  }, [
    descriptionDraft,
    markDescriptionSent,
    task.description,
    task.id,
    task.title,
    titleDraft,
    toast,
    updateTask,
  ]);
  const isBriefDirty = descriptionDraft !== task.description;
  // The brief writes itself: a keystroke schedules the write, so a draft that
  // differs is a write already on its way rather than one waiting for the user
  // to leave the field.
  const briefSaveState = resolveBriefSaveState({
    isSaving: isSavingBrief,
    isDirty: isBriefDirty,
  });
  useEffect(() => {
    if (!isBriefDirty) return;
    const timer = setTimeout(saveBrief, BRIEF_AUTOSAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [isBriefDirty, saveBrief]);
  const startTitleEdit = useCallback(() => setIsTitleEditing(true), []);
  const endTitleEdit = useCallback(() => {
    setIsTitleEditing(false);
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

  // The host confirms before it deletes, so this only asks. The sheet stops
  // rendering on its own once the task is gone from the snapshot.
  const handleDelete = useMemo(
    () => (onDeleteTask ? () => onDeleteTask(task.id) : undefined),
    [onDeleteTask, task.id],
  );

  const planCwd = useKanbanProjectCwd(serverId, paseoProjectId);
  const taskKey = formatTaskKey(project, task);
  // Stable identity: the plan editor seeds its form from this, and a fresh empty
  // array on every render would re-run that seeding mid-edit.
  const steps = useMemo(() => workflow?.steps ?? EMPTY_STEPS, [workflow?.steps]);
  const { surfaceStep, surfaceStepIndex } = resolveSurfaceStep(subSurface, steps);
  const header = useMemo(() => {
    // Starting the task and the overflow belong to the task, not to the screen
    // the user happens to have drilled into, so a sub-surface keeps them: going
    // back out to start work would lose the place they were editing.
    const desktopActions = (
      <View style={styles.headerActions}>
        <TaskStartControl
          presets={presets}
          isAggregate={isAggregate}
          disabled={blockers.length > 0 || isDelegating}
          onStart={handleDelegate}
        />
        <TaskDetailOverflowMenu
          isAggregate={isAggregate}
          onEditPlan={openPlanSurface}
          onChangeAutomation={openAutomationSurface}
          onDelete={handleDelete}
        />
      </View>
    );
    if (subSurface) {
      return {
        title: resolveSubSurfaceTitle({ subSurface, surfaceStep, surfaceStepIndex }),
        back: { onPress: closeSubSurface },
        // Compact has one column: back, title and close already fill the row.
        actions: isCompact ? undefined : desktopActions,
      };
    }
    // Desktop keeps the title and the one primary action on the header row: the
    // chips have moved to the rail and the tabs into the left pane.
    if (!isCompact) {
      return {
        title: task.title,
        titleContent: (
          <View style={styles.headerIdentityRow}>
            <Text style={styles.taskKeyBadge} numberOfLines={1}>
              {taskKey}
            </Text>
            <TaskDetailTitleInput
              task={task}
              isTitleEditing={isTitleEditing}
              onTitleChange={setTitleDraft}
              onTitleEdit={startTitleEdit}
              onTitleBlur={endTitleEdit}
              onTitleSave={saveBrief}
            />
          </View>
        ),
        actions: desktopActions,
      };
    }
    return {
      title: task.title,
      titleContent: <Text style={styles.taskKey}>{taskKey}</Text>,
      after: (
        <TaskDetailHeaderBody
          task={task}
          isTitleEditing={isTitleEditing}
          onTitleChange={setTitleDraft}
          onTitleEdit={startTitleEdit}
          onTitleBlur={endTitleEdit}
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
    handleDelete,
    openAutomationSurface,
    openPlanSurface,
    deleteLabel,
    handleDelegate,
    handleSelectPriority,
    handleSelectStatus,
    handleSetDueDate,
    handleSetLabelIds,
    endTitleEdit,
    startTitleEdit,
    isAggregate,
    isCompact,
    isDelegating,
    isTitleEditing,
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
  const composer = useMemo(
    () =>
      subSurface || activeTab !== "activity" ? null : (
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
      ),
    [
      activeTab,
      isPosting,
      noteDraft,
      noteResetKey,
      sendMessage,
      serverId,
      subSurface,
      submitNote,
      supportsMessages,
      task,
    ],
  );

  // On desktop the composer belongs to the conversation pane, not to the sheet:
  // the rail runs past it to the bottom edge, as the design has it.
  const footer = useMemo(() => {
    if (subSurface) {
      return undefined;
    }
    if (isCompact && activeTab === "activity") {
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
  const automationFacts = resolveAutomationFacts(task, project);

  // Details owns the breakdown, on every task: the section is how the first
  // subtask gets created, so hiding it until one exists would close the door.
  const subtasksSection = (
    <TaskSubtasksSection
      subtasks={subtasks}
      projectsById={projectsById}
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
  );

  const body = subSurface ? (
    <TaskDetailSubSurfaceBody
      subSurface={subSurface}
      surfaceStep={surfaceStep}
      serverId={serverId}
      paseoProjectId={paseoProjectId}
      task={task}
      project={project}
      presets={presets}
      steps={steps}
      isAggregate={isAggregate}
      isActing={isActing}
      isBusy={isBusy}
      onAct={handleStepAction}
      onOpenAgent={handleOpenAgent}
      onSaveWorkflow={setWorkflow}
      onPlanSaved={closeSubSurface}
    />
  ) : (
    <>
      {activeTab === "execution" ? (
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
            onOpenTask={onOpenTask}
          />
          <TaskPlanSection
            serverId={serverId}
            cwd={planCwd}
            workflow={workflow}
            isAggregate={isAggregate}
            isActing={isActing}
            isCompact={isCompact}
            automationSummary={automationSummary}
            onChangeAutomation={openAutomationSurface}
            onEdit={openPlanSurface}
            onAct={handleStepAction}
            onOpenAgent={handleOpenAgent}
            onOpenStep={openStepSurface}
          />
        </View>
      ) : null}

      {activeTab === "details" ? (
        <View style={styles.tabContent} testID="task-detail-details-tab">
          <TaskOverview
            task={task}
            saveState={briefSaveState}
            resetKey={descriptionResetKey}
            onDescriptionChange={setDescriptionDraft}
            onSave={saveBrief}
          />
          <View style={styles.groupContent} testID="task-detail-details-group">
            {subtasksSection}
            {isCompact ? (
              <TaskRelationshipsSection relationships={relationships} projectsById={projectsById} />
            ) : null}
            <TaskAttachmentsSection task={task} />
            <TaskDetailMetaSection task={task} project={project} presets={presets} />
          </View>
        </View>
      ) : null}

      {activeTab === "activity" ? (
        <View style={styles.tabContent} testID="task-detail-activity-tab">
          <TaskUpdatesSection comments={comments} serverId={serverId} />
        </View>
      ) : null}
    </>
  );

  return (
    <AdaptiveModalSheet
      header={header}
      visible
      onClose={handleClose}
      enableSwipeToDismiss={subSurface === null}
      desktopMaxWidth={isCompact ? undefined : DESKTOP_MAX_WIDTH}
      scrollable={isCompact}
      contentStyle={isCompact ? undefined : styles.desktopSplitContent}
      testID="task-detail-sheet"
      footer={footer}
      footerContainerStyle={styles.unifiedComposerFooter}
    >
      {isCompact ? (
        body
      ) : (
        <View style={styles.desktopSplit}>
          <View style={styles.desktopLeftPane} testID="task-detail-left-pane">
            {subSurface ? null : (
              <View style={[styles.tabBar, styles.desktopTabBar]} accessibilityRole="tablist">
                <TaskDetailTabButton
                  tab="execution"
                  label="Execution"
                  activeTab={activeTab}
                  onSelect={setActiveTab}
                />
                <TaskDetailTabButton
                  tab="details"
                  label="Details"
                  activeTab={activeTab}
                  onSelect={setActiveTab}
                />
                <TaskDetailTabButton
                  tab="activity"
                  label="Activity"
                  activeTab={activeTab}
                  onSelect={setActiveTab}
                />
              </View>
            )}
            <ScrollView
              style={styles.desktopPaneScroll}
              contentContainerStyle={styles.desktopPaneScrollContent}
              keyboardShouldPersistTaps="handled"
            >
              <View style={styles.desktopPaneContent}>{body}</View>
            </ScrollView>
            {composer ? <View style={styles.desktopComposer}>{composer}</View> : null}
          </View>
          <TaskDetailPropertyRail
            task={task}
            projectsById={projectsById}
            projectLabels={projectLabels}
            selectedLabelIds={labelIdsDraft}
            supportsLabelDeletion={supportsLabelDeletion}
            onSelectStatus={handleSelectStatus}
            onSelectPriority={handleSelectPriority}
            onSetDueDate={handleSetDueDate}
            onSetLabelIds={handleSetLabelIds}
            onCreateLabel={createLabel}
            onDeleteLabel={deleteLabel}
            executionGroups={executionGroups}
            relationships={relationships}
            subtasks={subtasks}
            automation={automationFacts}
            onChangeAutomation={openAutomationSurface}
            onOpenAgent={handleOpenAgent}
            onOpenTask={onOpenTask}
          />
        </View>
      )}
    </AdaptiveModalSheet>
  );
}

function sameStringArrays(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * A draft that follows the host, except when the host is only echoing this
 * client's own write. Re-deriving on an echo would drop whatever was typed while
 * the write was in flight and send the cursor back into older text, which is
 * exactly what happens when a field saves as you type.
 *
 * `resetKey` changes only on a foreign edit, so the uncontrolled input reseeds
 * for a change made elsewhere and is left alone for our own.
 */
function useEchoAwareDraft(serverValue: string): {
  draft: string;
  setDraft: (value: string) => void;
  resetKey: string;
  markSent: (value: string) => void;
} {
  const [draft, setDraft] = useState(serverValue);
  const [foreignEdits, setForeignEdits] = useState(0);
  const serverValueRef = useRef(serverValue);
  const sentValueRef = useRef(serverValue);
  if (serverValueRef.current !== serverValue) {
    serverValueRef.current = serverValue;
    if (serverValue !== sentValueRef.current) {
      setDraft(serverValue);
      setForeignEdits((current) => current + 1);
    }
  }
  const markSent = useCallback((value: string) => {
    sentValueRef.current = value;
  }, []);
  return { draft, setDraft, resetKey: String(foreignEdits), markSent };
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
  paseoProjectId,
  task,
  project,
  presets,
  steps,
  isAggregate,
  isActing,
  isBusy,
  onAct,
  onOpenAgent,
  onSaveWorkflow,
  onPlanSaved,
}: {
  subSurface: TaskDetailSubSurface;
  surfaceStep: Step | undefined;
  serverId: string;
  paseoProjectId: string;
  task: Task;
  project: TaskProject | undefined;
  presets: readonly TaskPreset[];
  steps: readonly Step[];
  isAggregate: boolean;
  isActing: boolean;
  isBusy: boolean;
  onAct: (stepId: string, action: TaskStepAction) => void;
  onOpenAgent: (input: { workspaceId: string; agentId: string }) => void;
  onSaveWorkflow: (input: { taskId: string; steps: StepInput[] }) => Promise<unknown>;
  onPlanSaved: () => void;
}): ReactElement {
  const cwd = useKanbanProjectCwd(serverId, paseoProjectId);
  return (
    <View style={styles.tabContent} testID="task-detail-sub-surface">
      {subSurface.kind === "plan" ? (
        <TaskDetailPlanSurface
          serverId={serverId}
          paseoProjectId={paseoProjectId}
          taskId={task.id}
          existingSteps={steps}
          isBusy={isBusy}
          onSaveWorkflow={onSaveWorkflow}
          onSaved={onPlanSaved}
          onCancel={onPlanSaved}
        />
      ) : null}
      {subSurface.kind === "automation" ? (
        <TaskAutomationSection
          serverId={serverId}
          task={task}
          project={project}
          presets={presets}
          hasSubtasks={isAggregate}
        />
      ) : null}
      {subSurface.kind === "step" && surfaceStep ? (
        <TaskStepSurface
          serverId={serverId}
          cwd={cwd}
          step={surfaceStep}
          disabled={isActing || isAggregate}
          onAct={onAct}
          onOpenAgent={onOpenAgent}
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

/**
 * The plan editor as a sub-surface of the task: the same form the board used to
 * open as a sheet of its own, so leaving it returns to the task instead of
 * popping the whole stack back to the board.
 */
function TaskDetailPlanSurface({
  serverId,
  paseoProjectId,
  taskId,
  existingSteps,
  isBusy,
  onSaveWorkflow,
  onSaved,
  onCancel,
}: {
  serverId: string;
  paseoProjectId: string;
  taskId: string;
  existingSteps: readonly Step[];
  isBusy: boolean;
  onSaveWorkflow: (input: { taskId: string; steps: StepInput[] }) => Promise<unknown>;
  onSaved: () => void;
  onCancel: () => void;
}): ReactElement {
  const cwd = useKanbanProjectCwd(serverId, paseoProjectId);
  const snapshot = useMemo(
    () => ({ serverId, taskId, cwd, existingSteps }),
    [cwd, existingSteps, serverId, taskId],
  );
  const model = useTaskWorkflowFormModel(snapshot);
  const state = useSyncExternalStore(model.subscribe, model.getState, model.getState);
  const canSubmit = state.canSubmit && !isBusy;
  const handleAutoContinue = useCallback((value: boolean) => model.setAutoContinue(value), [model]);
  const handleSubmit = useCallback(() => {
    if (!canSubmit) {
      return;
    }
    const steps = buildTaskWorkflowSteps(state);
    if (!steps) {
      return;
    }
    model.setSubmitError(null);
    void onSaveWorkflow({ taskId: state.taskId, steps })
      .then(onSaved)
      .catch((submitError: unknown) => model.setSubmitError(toErrorMessage(submitError)));
  }, [canSubmit, model, onSaveWorkflow, onSaved, state]);

  return (
    <View style={styles.planForm} testID="task-detail-plan-surface">
      <Text style={styles.policyIntroText}>
        The task brief is sent with every step. Add instructions only where they differ.
      </Text>
      <View style={styles.planFormSteps}>
        {state.steps.map((step, index) => (
          <TaskWorkflowStepEditor
            key={step.key}
            step={step}
            index={index}
            stepCount={state.steps.length}
            state={state}
            model={model}
          />
        ))}
      </View>
      <Button
        variant="ghost"
        size="sm"
        leftIcon={Plus}
        style={styles.planAddStep}
        onPress={model.addStep}
        testID="task-detail-plan-add-step"
      >
        Add step
      </Button>
      {state.submitError ? (
        <Text style={styles.planFormError} testID="task-detail-plan-error">
          {state.submitError}
        </Text>
      ) : null}
      <View style={styles.planActions}>
        <View style={styles.planContinuation} testID="task-detail-plan-auto-continue">
          <Text style={styles.rowTitle}>Continue automatically</Text>
          <Switch
            value={state.autoContinue}
            onValueChange={handleAutoContinue}
            accessibilityLabel="Continue automatically"
            testID="task-detail-plan-auto-continue-switch"
          />
        </View>
        <Button variant="ghost" size="sm" onPress={onCancel} testID="task-detail-plan-cancel">
          Cancel
        </Button>
        <Button
          variant="default"
          size="sm"
          onPress={handleSubmit}
          disabled={!canSubmit}
          loading={isBusy}
          testID="task-detail-plan-submit"
        >
          Save plan
        </Button>
      </View>
    </View>
  );
}

/**
 * The rail beside the tabs on desktop: the properties a card is triaged by, the
 * agents running right now, and what the task hangs off. It survives every tab
 * and every sub-surface, so glanceable state is never the thing that scrolled
 * away.
 */
function TaskDetailPropertyRail({
  task,
  projectsById,
  projectLabels,
  selectedLabelIds,
  supportsLabelDeletion,
  onSelectStatus,
  onSelectPriority,
  onSetDueDate,
  onSetLabelIds,
  onCreateLabel,
  onDeleteLabel,
  executionGroups,
  relationships,
  subtasks,
  automation,
  onChangeAutomation,
  onOpenAgent,
  onOpenTask,
}: {
  task: Task;
  projectsById: ReadonlyMap<string, TaskProject>;
  projectLabels: readonly TaskLabel[];
  selectedLabelIds: readonly string[];
  supportsLabelDeletion: boolean;
  onSelectStatus: (status: TaskStatus) => void;
  onSelectPriority: (priority: TaskPriority) => void;
  onSetDueDate: (dueDate: string | null) => Promise<Task>;
  onSetLabelIds: (labelIds: string[]) => Promise<Task>;
  onCreateLabel: (input: { projectId: string; name: string; color: string }) => Promise<string>;
  onDeleteLabel: (labelId: string) => Promise<void>;
  executionGroups: readonly TaskExecutionWorkspaceGroup[];
  relationships: readonly TaskRelationship[];
  subtasks: readonly Task[];
  automation: TaskAutomationFacts;
  onChangeAutomation: () => void;
  onOpenAgent: (input: { workspaceId: string; agentId: string }) => void;
  onOpenTask: ((taskId: string) => void) | undefined;
}): ReactElement {
  const openSubtaskCount = subtasks.filter(
    (subtask) => subtask.status !== "done" && subtask.status !== "canceled",
  ).length;
  return (
    <ScrollView
      style={styles.rail}
      contentContainerStyle={styles.railContent}
      testID="task-detail-rail"
    >
      <View style={styles.railGroup}>
        <View style={styles.railChips}>
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
          <TaskDueDateChip
            dueDate={task.dueDate}
            onSetDueDate={onSetDueDate}
            testID="task-detail-due-trigger"
          />
        </View>
      </View>
      <TaskRailAgents groups={executionGroups} onOpenAgent={onOpenAgent} />
      <View style={styles.railGroup} testID="task-detail-rail-automation">
        <View style={styles.railGroupHeader}>
          <Text style={styles.railHeading}>Automation</Text>
          <Button
            variant="ghost"
            size="xs"
            onPress={onChangeAutomation}
            testID="task-detail-automation-change"
          >
            Change
          </Button>
        </View>
        <TaskRailFact icon={ThemedGitBranch} label={automation.workspace} />
        <TaskRailFact icon={ThemedEye} label={automation.review} />
        <TaskRailFact icon={ThemedArchive} label={automation.cleanup} />
      </View>
      {relationships.length > 0 || subtasks.length > 0 ? (
        <View style={styles.railGroup} testID="task-detail-rail-relations">
          <Text style={styles.railHeading}>Relations</Text>
          {relationships.map((relationship) => (
            <TaskRailRelationRow
              key={`${relationship.label}-${relationship.task.id}`}
              kind={relationship.kind}
              label={relationship.label}
              task={relationship.task}
              taskKey={formatTaskKey(
                projectsById.get(relationship.task.projectId),
                relationship.task,
              )}
              onOpenTask={onOpenTask}
            />
          ))}
          {subtasks.length > 0 ? (
            <TaskRailFact
              icon={ThemedListTree}
              label={`${subtasks.length} ${subtasks.length === 1 ? "subtask" : "subtasks"} · ${openSubtaskCount} open`}
            />
          ) : null}
        </View>
      ) : null}
    </ScrollView>
  );
}

/** The three automation facts the rail states, one line each. */
interface TaskAutomationFacts {
  workspace: string;
  review: string;
  cleanup: string;
}

function resolveAutomationFacts(task: Task, project: TaskProject | undefined): TaskAutomationFacts {
  const effective = resolveTaskExecutionPolicy(project?.board, task.executionPolicy);
  let workspace = "Preset workspace";
  if (effective.workspace === "dedicated") {
    workspace = "Dedicated worktrees";
  } else if (effective.workspace === "reuse") {
    workspace = "Task workspace";
  }
  return {
    workspace,
    review: effective.reviewEnabled ? `Review ×${effective.maxReviewIterations}` : "No review",
    cleanup: effective.archiveWorkspacesOnDone ? "Archive worktrees" : "Keep worktrees",
  };
}

/** One fact of the rail: a 14px icon and the line it labels. */
function TaskRailFact({
  icon: Icon,
  iconMapping = mutedIconMapping,
  label,
}: {
  icon: typeof ThemedGitBranch;
  iconMapping?: (theme: Theme) => { color: string };
  label: string;
}): ReactElement {
  return (
    <View style={styles.railFact}>
      <Icon size={ICON_SIZE.sm} uniProps={iconMapping} />
      <Text style={styles.railDetail} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

/** One relation as the rail states it: what it is, which task, and a press that
 * swaps the sheet onto it. */
function TaskRailRelationRow({
  kind,
  label,
  task,
  taskKey,
  onOpenTask,
}: {
  kind: TaskRelationKind;
  label: string;
  task: Task;
  taskKey: string;
  onOpenTask: ((taskId: string) => void) | undefined;
}): ReactElement {
  const handlePress = useCallback(() => onOpenTask?.(task.id), [onOpenTask, task.id]);
  const Icon = kind === "blocker" ? ThemedClock : ThemedCornerUpLeft;
  const iconMapping = kind === "blocker" ? dangerIconMapping : mutedIconMapping;
  const sentence = `${label} ${taskKey}`;
  if (!onOpenTask) {
    return <TaskRailFact icon={Icon} iconMapping={iconMapping} label={sentence} />;
  }
  return (
    <Pressable
      onPress={handlePress}
      accessibilityRole="button"
      hitSlop={SPACING[1]}
      style={styles.railFact}
      testID={`task-detail-rail-relation-${task.id}`}
    >
      <Icon size={ICON_SIZE.sm} uniProps={iconMapping} />
      <Text style={styles.railDetailLink} numberOfLines={1}>
        {sentence}
      </Text>
    </Pressable>
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
  onOpenTask,
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
  onOpenTask: ((taskId: string) => void) | undefined;
}): ReactElement | null {
  if (task.status !== "in_review" && blockers.length === 0) {
    return null;
  }
  return (
    <View style={styles.bannerStack} testID="task-detail-attention">
      {blockers.length > 0 ? (
        <TaskBlockersSection
          blockers={blockers}
          projectsById={projectsById}
          onOpenTask={onOpenTask}
        />
      ) : null}
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
    </View>
  );
}

/** The header below the key row: full-width editable title, the property chip
 * rail, and the tab bar — one surface for identity and properties. */
/**
 * The task title, edited in place and written on blur.
 *
 * The editing frame follows the writing, not the focus: a web overlay hands its
 * initial focus to the first focusable node in scope (see lib/overlay-root.ts),
 * which here is this field, so a sheet opened to read a plan would arrive
 * looking like a rename in progress. Focus itself is left alone — Tab order and
 * keyboard entry are unchanged — and the caret already says where typing lands.
 */
function TaskDetailTitleInput({
  task,
  isTitleEditing,
  onTitleChange,
  onTitleEdit,
  onTitleBlur,
  onTitleSave,
}: {
  task: Task;
  isTitleEditing: boolean;
  onTitleChange: (title: string) => void;
  onTitleEdit: () => void;
  onTitleBlur: () => void;
  onTitleSave: () => void;
}): ReactElement {
  const handleChangeText = useCallback(
    (title: string) => {
      onTitleEdit();
      onTitleChange(title);
    },
    [onTitleChange, onTitleEdit],
  );
  return (
    <AdaptiveTextInput
      initialValue={task.title}
      resetKey={task.title}
      onChangeText={handleChangeText}
      onBlur={onTitleBlur}
      onEndEditing={onTitleSave}
      placeholder="What needs to be done?"
      style={[
        styles.headerTitleInput,
        isTitleEditing ? styles.headerTitleEditing : null,
        isWeb ? { outlineWidth: 0, outlineColor: "transparent" } : null,
      ]}
      testID={TITLE_INPUT_TEST_ID}
    />
  );
}

/** The compact header below the title row: chips under the title, then the
 * sticky tabs. Desktop puts the chips in the rail and the tabs in the left
 * pane, so this is compact-only. */
function TaskDetailHeaderBody({
  task,
  isTitleEditing,
  onTitleChange,
  onTitleEdit,
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
  stepCount,
  activityCount,
  activeTab,
  onSelectTab,
}: {
  task: Task;
  isTitleEditing: boolean;
  onTitleChange: (title: string) => void;
  onTitleEdit: () => void;
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
  stepCount: number;
  activityCount: number;
  activeTab: TaskDetailTab;
  onSelectTab: (tab: TaskDetailTab) => void;
}): ReactElement {
  return (
    <View style={styles.headerBody}>
      <View style={styles.headerTitleBlock}>
        <TaskDetailTitleInput
          task={task}
          isTitleEditing={isTitleEditing}
          onTitleChange={onTitleChange}
          onTitleEdit={onTitleEdit}
          onTitleBlur={onTitleBlur}
          onTitleSave={onTitleSave}
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
      </View>
      <View style={[styles.tabBar, styles.compactTabBar]} accessibilityRole="tablist">
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

/** The header's overflow: what the task can do that no other control on the
 * surface already offers. */
function TaskDetailOverflowMenu({
  isAggregate,
  onEditPlan,
  onChangeAutomation,
  onDelete,
}: {
  isAggregate: boolean;
  onEditPlan: () => void;
  onChangeAutomation: () => void;
  onDelete: (() => void) | undefined;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <DropdownMenu>
      <DropdownTrigger
        style={styles.headerMenuTrigger}
        chevron={null}
        testID="task-detail-overflow"
      >
        <ThemedMoreHorizontal size={ICON_SIZE.md} uniProps={mutedIconMapping} />
      </DropdownTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          onSelect={onEditPlan}
          disabled={isAggregate}
          testID="task-detail-overflow-plan"
        >
          {t("tasks.workflow.addToTask")}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onChangeAutomation} testID="task-detail-overflow-automation">
          Automation & delivery
        </DropdownMenuItem>
        {onDelete ? (
          <DropdownMenuItem onSelect={onDelete} testID="task-detail-overflow-delete">
            {t("tasks.board.delete")}
          </DropdownMenuItem>
        ) : null}
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
            numberOfLines={1}
            testID={`task-detail-${activeMode}-input`}
          />
        </View>
        <Button
          variant="secondary"
          size="sm"
          style={styles.composerSend}
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

/** Where the brief stands with the host. There is no "unsaved": a keystroke
 * schedules the write, so anything not yet stored is on its way. */
type TaskBriefSaveState = "saved" | "saving";

function resolveBriefSaveState(input: { isSaving: boolean; isDirty: boolean }): TaskBriefSaveState {
  return input.isSaving || input.isDirty ? "saving" : "saved";
}

/** How long the brief waits for the typing to settle before it writes. Long
 * enough that a sentence is one write, short enough that leaving the screen
 * straight after typing has nothing left to lose. */
const BRIEF_AUTOSAVE_DELAY_MS = 600;

/** How long a dot waits before the next one joins it. */
const SAVING_DOT_INTERVAL_MS = 400;
const SAVING_DOT_COUNT = 3;

/**
 * The brief's standing, stated where the brief is. The dots animate only while a
 * write is actually in flight — a label that says "saving" over an idle field
 * teaches people to ignore it.
 */
function TaskBriefSaveHint({ state }: { state: TaskBriefSaveState }): ReactElement {
  const [dots, setDots] = useState(1);
  useEffect(() => {
    if (state !== "saving") {
      setDots(1);
      return;
    }
    const timer = setInterval(
      () => setDots((current) => (current % SAVING_DOT_COUNT) + 1),
      SAVING_DOT_INTERVAL_MS,
    );
    return () => clearInterval(timer);
  }, [state]);
  const standing = state === "saving" ? `Saving${".".repeat(dots)}` : "Saved";
  return (
    <Text style={styles.sectionHint} testID="task-detail-brief-save-state">
      {standing} · sent with every step
    </Text>
  );
}

function TaskOverview({
  task,
  saveState,
  resetKey,
  onDescriptionChange,
  onSave,
}: {
  task: Task;
  saveState: TaskBriefSaveState;
  resetKey: string;
  onDescriptionChange: (description: string) => void;
  onSave: () => void;
}): ReactElement {
  const trailing = useMemo(() => <TaskBriefSaveHint state={saveState} />, [saveState]);
  return (
    <DetailSection title="Brief" testID="task-detail-brief" trailing={trailing}>
      <AdaptiveTextInput
        initialValue={task.description}
        resetKey={resetKey}
        onChangeText={onDescriptionChange}
        onBlur={onSave}
        onEndEditing={onSave}
        placeholder="Describe the outcome, context, and constraints for the agent"
        style={styles.detailsDescriptionInput}
        multiline
        testID="task-detail-description-input"
      />
    </DetailSection>
  );
}

/** The verdict where the change is read: the banner states the round, takes the
 * correction feedback, and settles the task without leaving the sheet. */
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
    <View style={[styles.banner, styles.bannerReview]} testID="task-detail-review">
      <View style={styles.bannerHeader}>
        <ThemedEye size={ICON_SIZE.sm} uniProps={warningIconMapping} />
        <Text style={styles.bannerTitle}>{t("tasks.detail.reviewerHeading")}</Text>
        {iteration ? <Text style={styles.bannerHint}>Correction round {iteration}</Text> : null}
      </View>
      <FormTextInput
        onChangeText={onFeedbackChange}
        placeholder="Correction feedback (sent to the worker on rejection)"
        multiline
        editable={!isReviewing}
        testID="task-detail-review-feedback"
      />
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
    </View>
  );
}

/** What the task waits for, one banner per blocker, each opening the task that
 * has to settle before any step here can run. */
function TaskBlockersSection({
  blockers,
  projectsById,
  onOpenTask,
}: {
  blockers: readonly Task[];
  projectsById: ReadonlyMap<string, TaskProject>;
  onOpenTask: ((taskId: string) => void) | undefined;
}): ReactElement {
  return (
    <View style={styles.bannerStack} testID="task-detail-blockers">
      {blockers.map((blocker) => (
        <TaskBlockerBanner
          key={blocker.id}
          blocker={blocker}
          blockerKey={formatTaskKey(projectsById.get(blocker.projectId), blocker)}
          onOpenTask={onOpenTask}
        />
      ))}
    </View>
  );
}

function TaskBlockerBanner({
  blocker,
  blockerKey,
  onOpenTask,
}: {
  blocker: Task;
  blockerKey: string;
  onOpenTask: ((taskId: string) => void) | undefined;
}): ReactElement {
  const { t } = useTranslation();
  const handleOpen = useCallback(() => onOpenTask?.(blocker.id), [blocker.id, onOpenTask]);
  return (
    <View style={[styles.banner, styles.bannerBlocked]}>
      <View style={styles.bannerHeader}>
        <ThemedClock size={ICON_SIZE.sm} uniProps={dangerIconMapping} />
        <View style={styles.bannerCopy}>
          <Text style={styles.bannerTitle} numberOfLines={1}>
            {t("tasks.detail.blockedHeading")} {blocker.title}
          </Text>
          <Text style={styles.bannerHintBlock}>Steps cannot run until {blockerKey} is done.</Text>
        </View>
        {onOpenTask ? (
          <Button
            variant="ghost"
            size="xs"
            onPress={handleOpen}
            testID={`task-detail-blocker-open-${blocker.id}`}
          >
            Open
          </Button>
        ) : null}
      </View>
    </View>
  );
}

function TaskRelationshipsSection({
  relationships,
  projectsById,
}: {
  relationships: readonly TaskRelationship[];
  projectsById: ReadonlyMap<string, TaskProject>;
}): ReactElement | null {
  if (relationships.length === 0) return null;
  return (
    <DetailSection title="Relationships" testID="task-detail-relationships">
      <View style={styles.card}>
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
    </DetailSection>
  );
}

function TaskAttachmentsSection({ task }: { task: Task }): ReactElement | null {
  if (task.attachments.length === 0) return null;
  return (
    <DetailSection title="Attachments" testID="task-detail-attachments">
      <View style={styles.card}>
        {task.attachments.map((attachment, index) => (
          <View key={attachment.id} style={[styles.row, index > 0 ? styles.rowBorder : null]}>
            <View style={styles.rowContent}>
              <Text style={styles.rowTitle} numberOfLines={1}>
                {attachment.fileName}
              </Text>
            </View>
          </View>
        ))}
      </View>
    </DetailSection>
  );
}

/** The facts nobody edits: where the task lives, when it moved, what starts it.
 * Last on Details because it answers questions asked after the work. */
function TaskDetailMetaSection({
  task,
  project,
  presets,
}: {
  task: Task;
  project: TaskProject | undefined;
  presets: readonly TaskPreset[];
}): ReactElement {
  const presetName = task.executionSpec
    ? (presets.find((preset) => preset.id === task.executionSpec?.presetId)?.name ??
      "Missing preset")
    : "Started by hand";
  return (
    <View style={styles.metaRows} testID="task-detail-meta">
      <TaskDetailMetaRow
        label="Project"
        value={project ? `${project.name} · ${project.prefix}` : "—"}
      />
      <TaskDetailMetaRow label="Created" value={formatMetaTimestamp(task.createdAt)} />
      <TaskDetailMetaRow label="Updated" value={formatMetaTimestamp(task.updatedAt)} />
      <TaskDetailMetaRow label="Preset" value={presetName} />
    </View>
  );
}

function TaskDetailMetaRow({ label, value }: { label: string; value: string }): ReactElement {
  return (
    <View style={styles.metaRow}>
      <Text style={styles.metaLabel}>{label}</Text>
      <Text style={styles.metaValue} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

function formatMetaTimestamp(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "—" : formatDateStamp(date);
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
      {groups.map(({ entry, repeatCount, firstCreatedAt }, index) => {
        const previous = groups[index - 1]?.entry;
        const day = resolveActivityDay(entry.createdAt);
        return (
          <Fragment key={entry.id}>
            {day && day !== resolveActivityDay(previous?.createdAt) ? (
              <ActivityDayDivider label={day} />
            ) : null}
            <BoardFeedEntryRow
              entry={entry}
              serverId={serverId}
              appearance="activity"
              collapsible
              activityRepeatCount={repeatCount}
              activityFirstCreatedAt={firstCreatedAt}
              activityShowHeader={activityFeedShowsHeader(previous, entry)}
            />
          </Fragment>
        );
      })}
    </View>
  );
}

/** Where one day of the feed ends and the next begins: a label centred between
 * two hairlines, so the break is read as a break rather than as another entry
 * in the column of events. */
function ActivityDayDivider({ label }: { label: string }): ReactElement {
  return (
    <View style={styles.activityDay}>
      <View style={styles.activityDayRule} />
      <Text style={styles.activityDayLabel}>{label}</Text>
      <View style={styles.activityDayRule} />
    </View>
  );
}

/** The day a feed entry belongs to, as the timeline labels it: today and
 * yesterday by name, anything older by its date. */
function resolveActivityDay(iso: string | undefined): string | null {
  if (!iso) return null;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  const now = new Date();
  const days = Math.round(
    (startOfDay(now).getTime() - startOfDay(at).getTime()) / MILLISECONDS_PER_DAY,
  );
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return at.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
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
 * rail owns it on desktop, so here it is only the drill-in row compact needs.
 */
function TaskPlanSection({
  serverId,
  cwd,
  workflow,
  isAggregate,
  isActing,
  isCompact,
  automationSummary,
  onChangeAutomation,
  onEdit,
  onAct,
  onOpenAgent,
  onOpenStep,
}: {
  serverId: string;
  cwd: string | null;
  workflow: TaskWorkflow | null;
  isAggregate: boolean;
  isActing: boolean;
  isCompact: boolean;
  automationSummary: string;
  onChangeAutomation: () => void;
  onEdit: () => void;
  onAct: (stepId: string, action: TaskStepAction) => void;
  onOpenAgent: (input: { workspaceId: string; agentId: string }) => void;
  onOpenStep: (stepId: string) => void;
}): ReactElement {
  const steps = workflow?.steps ?? [];
  const trailing = useMemo(
    () =>
      steps.length > 0 && !isAggregate ? (
        <Button variant="ghost" size="xs" onPress={onEdit} testID="task-detail-plan-edit">
          Edit
        </Button>
      ) : null,
    [isAggregate, onEdit, steps.length],
  );
  return (
    <DetailSection title="Plan" testID="task-detail-workflow" trailing={trailing}>
      {isAggregate ? <Text style={styles.rowHint}>{AGGREGATE_WORK_REFUSAL}</Text> : null}
      {steps.length > 0 ? (
        <View style={styles.card}>
          {steps.map((step, index) => (
            <PlanStepRow
              key={step.id}
              serverId={serverId}
              cwd={cwd}
              step={step}
              index={index}
              withBorder={index > 0}
              disabled={isActing || isAggregate}
              isCompact={isCompact}
              onAct={onAct}
              onOpenAgent={onOpenAgent}
              onOpenStep={onOpenStep}
            />
          ))}
          {isAggregate ? null : (
            <Pressable
              onPress={onEdit}
              accessibilityRole="button"
              style={[styles.row, styles.rowBorder, styles.addRow]}
              testID="task-detail-workflow-edit"
            >
              <ThemedPlus size={ICON_SIZE.sm} uniProps={extraMutedIconMapping} />
              <Text style={styles.addRowLabel}>Add step</Text>
            </Pressable>
          )}
        </View>
      ) : null}
      {steps.length > 0 || isAggregate ? null : (
        <View style={styles.planEmpty}>
          <Text style={styles.emptyComments}>
            No saved plan. Start from a preset, or add a multi-step agent plan.
          </Text>
          <Button
            variant="ghost"
            size="sm"
            leftIcon={Plus}
            onPress={onEdit}
            testID="task-detail-workflow-edit"
          >
            Add plan
          </Button>
        </View>
      )}
      {isCompact ? (
        <View style={styles.card}>
          <Pressable
            onPress={onChangeAutomation}
            accessibilityRole="button"
            style={styles.row}
            testID="task-detail-automation-open"
          >
            <View style={styles.rowContent}>
              <Text style={styles.rowTitle}>Automation & delivery</Text>
              <Text style={styles.rowHint} numberOfLines={1}>
                {automationSummary}
              </Text>
            </View>
            <ThemedChevronRight size={ICON_SIZE.sm} uniProps={mutedIconMapping} />
          </Pressable>
        </View>
      ) : null}
    </DetailSection>
  );
}

/**
 * One plan step as a row: number, name, its agent once, and the one action its
 * last run allows. The brief expands in place on desktop and gets its own
 * screen on compact — read where you run, edit where you read.
 */
function PlanStepRow({
  serverId,
  cwd,
  step,
  index,
  withBorder,
  disabled,
  isCompact,
  onAct,
  onOpenAgent,
  onOpenStep,
}: {
  serverId: string;
  cwd: string | null;
  step: Step;
  index: number;
  withBorder: boolean;
  disabled: boolean;
  isCompact: boolean;
  onAct: (stepId: string, action: TaskStepAction) => void;
  onOpenAgent: (input: { workspaceId: string; agentId: string }) => void;
  onOpenStep: (stepId: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  // What is running is what you opened the task to read, so it starts open. A
  // press is a decision about this row and outlives the run that ends under it:
  // re-deriving the default would close what someone is reading the moment the
  // next step picks up.
  const [expansionOverride, setExpansionOverride] = useState<boolean | null>(null);
  const { status, actions, error } = resolveStepState(step);
  const primaryAction = actions.find((action) => action !== "skip");
  const hasSkip = actions.includes("skip");
  const agentTarget = resolveStepAgentTarget(step);
  const elapsed = formatSettledRunDuration(step);
  const isActive = status === "running" || status === "queued";
  const isExpanded = expansionOverride ?? isActive;
  const handlePress = useCallback(() => {
    if (isCompact) {
      onOpenStep(step.id);
      return;
    }
    setExpansionOverride((current) => !(current ?? isActive));
  }, [isActive, isCompact, onOpenStep, step.id]);
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
      style={[withBorder ? styles.rowBorder : null, isExpanded ? styles.planStepOpen : null]}
      testID={`task-detail-step-${step.id}`}
    >
      <Pressable
        onPress={handlePress}
        accessibilityRole="button"
        accessibilityState={accessibilityState}
        accessibilityLabel={`Step ${index + 1}: ${step.name}`}
        style={[styles.row, styles.planStepRow]}
        testID={`task-detail-step-toggle-${step.id}`}
      >
        <PlanStepStatusDot status={status} />
        <View style={[styles.rowContent, styles.stepTitleColumn]}>
          <Text
            style={[styles.stepTitle, isActive ? styles.stepTitleActive : null]}
            numberOfLines={1}
          >
            {step.name}
          </Text>
          {error ? (
            <Text style={styles.rowError} testID={`task-detail-step-${step.id}-error`}>
              {error}
            </Text>
          ) : null}
        </View>
        <StepModelLabel step={step} />
        <PlanStepTrailing
          stepId={step.id}
          status={status}
          elapsed={elapsed}
          action={primaryAction}
          disabled={disabled}
          onAct={onAct}
        />
        {isCompact ? <ThemedChevronRight size={ICON_SIZE.sm} uniProps={mutedIconMapping} /> : null}
      </Pressable>
      {!isCompact && isExpanded ? (
        <View style={styles.stepExpanded} testID={`task-detail-step-expanded-${step.id}`}>
          <StepReading serverId={serverId} cwd={cwd} step={step} />
          <View style={styles.stepExpandedFooter}>
            <View style={styles.stepChipRow} />
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

/**
 * Which model the step runs on, stated beside its duration and only stated: the
 * plan reads as a plan, and the one place that changes what a step runs is the
 * plan editor, where the model sits next to the effort and the permissions it
 * has to agree with.
 */
function StepModelLabel({ step }: { step: Step }): ReactElement {
  return (
    <Text style={styles.stepMeta} numberOfLines={1}>
      {formatStepAgentLabel(step)}
    </Text>
  );
}

/** A subtask's own status as one dot, the same vocabulary the plan uses. */
function TaskStatusDot({ status }: { status: TaskStatus }): ReactElement {
  return <View style={[styles.stepDot, resolveTaskDotTone(status)]} />;
}

function resolveTaskDotTone(status: TaskStatus) {
  if (status === "done") return styles.stepDotSucceeded;
  if (status === "in_progress") return styles.stepDotActive;
  if (status === "in_review") return styles.stepDotReview;
  if (status === "canceled") return styles.stepDotFailed;
  return styles.stepDotPending;
}

/** The step's state as the one mark the eye lands on first, before any word. */
/** The plan's right column: how long the last run took, then the one thing the
 * step can do or the state it is in. */
function PlanStepTrailing({
  stepId,
  status,
  elapsed,
  action,
  disabled,
  onAct,
}: {
  stepId: string;
  status: TaskStepDisplayStatus;
  elapsed: string | null;
  action: TaskStepAction | undefined;
  disabled: boolean;
  onAct: (stepId: string, action: TaskStepAction) => void;
}): ReactElement {
  const { t } = useTranslation();
  const isActive = status === "running" || status === "queued";
  const isFailed = status === "failed" || status === "interrupted" || status === "canceled";
  return (
    <View style={styles.stepTrailing}>
      {elapsed ? <Text style={styles.stepDuration}>{elapsed}</Text> : null}
      <View style={styles.stepStatusSlot}>
        {action ? (
          <StepActionButton stepId={stepId} action={action} disabled={disabled} onAct={onAct} />
        ) : (
          <Text
            style={[
              styles.stepStatus,
              status === "succeeded" ? styles.stepStatusSucceeded : null,
              isActive ? styles.stepStatusActive : null,
              isFailed ? styles.stepStatusFailed : null,
            ]}
          >
            {t(`tasks.detail.stepStatus.${status}`)}
          </Text>
        )}
      </View>
    </View>
  );
}

function PlanStepStatusDot({ status }: { status: TaskStepDisplayStatus }): ReactElement {
  return <View style={[styles.stepDot, resolveStepDotTone(status)]} />;
}

function resolveStepDotTone(status: TaskStepDisplayStatus) {
  if (status === "succeeded") return styles.stepDotSucceeded;
  if (status === "running" || status === "queued") return styles.stepDotActive;
  if (status === "failed" || status === "interrupted" || status === "canceled") {
    return styles.stepDotFailed;
  }
  return styles.stepDotPending;
}

/** Which agent runs the step: the model when it names one, else the provider. */
function formatStepAgentLabel(step: Step): string {
  const agent = step.agents[0];
  if (!agent) return "Agent";
  return agent.model ?? resolveProviderLabel(agent.provider);
}

/**
 * How long the step's last run took, once it is over. A running step is left
 * without a number on purpose: nothing here ticks, and a frozen "12m" beside a
 * live agent reads as progress that stopped.
 */
function formatSettledRunDuration(step: Step): string | null {
  const latest = step.runs.at(-1);
  if (!latest?.endedAt) {
    return null;
  }
  const started = new Date(latest.startedAt).getTime();
  const ended = new Date(latest.endedAt).getTime();
  if (Number.isNaN(started) || Number.isNaN(ended) || ended < started) {
    return null;
  }
  return formatDuration(ended - started);
}

/** How many lines of a brief the plan shows before it asks. */
const STEP_BRIEF_LINES = 4;

interface StepFact {
  label: string;
  value: string;
}

/**
 * What a step is set up to do, in the order it was decided: who runs it and
 * how, where, and what it has to satisfy. A setting the step does not carry is
 * left out rather than stated as a default — the list says what was chosen.
 */
function buildStepFacts(input: {
  step: Step;
  entries: readonly ProviderSnapshotEntry[] | undefined;
  t: (key: string) => string;
}): StepFact[] {
  const { step, entries, t } = input;
  return [
    { label: "Agent", value: formatStepAgentLabel(step) },
    ...buildStepAgentFacts({ agent: step.agents[0], entries, t }),
    { label: t("tasks.workflow.workspaceLabel"), value: formatWorkspaceMode(step) },
    ...buildStepRuleFacts({ step, t }),
  ];
}

function buildStepAgentFacts(input: {
  agent: StepAgentSpec | undefined;
  entries: readonly ProviderSnapshotEntry[] | undefined;
  t: (key: string) => string;
}): StepFact[] {
  const { agent, entries, t } = input;
  if (!agent) return [];
  const entry = entries?.find((candidate) => candidate.provider === agent.provider) ?? null;
  const model = entry?.models?.find((candidate) => candidate.id === agent.model) ?? null;
  const thinking =
    model?.thinkingOptions?.find((option) => option.id === agent.thinkingOptionId) ?? null;
  const facts: StepFact[] = [];
  if (agent.thinkingOptionId) {
    facts.push({
      label: t("tasks.presets.effortLabel"),
      value: thinking ? formatThinkingOptionLabel(thinking) : agent.thinkingOptionId,
    });
  }
  if (agent.modeId) {
    facts.push({
      label: t("tasks.presets.permissionLabel"),
      value: entry?.modes?.find((mode) => mode.id === agent.modeId)?.label ?? agent.modeId,
    });
  }
  if (agent.featureValues?.fast_mode === true) {
    facts.push({ label: "Fast mode", value: "On" });
  }
  return facts;
}

function buildStepRuleFacts(input: { step: Step; t: (key: string) => string }): StepFact[] {
  const { step, t } = input;
  const facts: StepFact[] = [];
  if (step.trigger.type === "schedule") {
    facts.push({ label: "Starts", value: t(TASK_WORKFLOW_TRIGGER_LABEL_KEYS.schedule) });
  }
  if (step.verify) {
    facts.push({ label: "Check", value: step.verify.command.join(" ") });
  }
  if (step.timeoutMs) {
    facts.push({ label: "Time limit", value: formatDuration(step.timeoutMs) });
  }
  if (step.requireChanges === false) {
    facts.push({ label: "Completion", value: "No changes required" });
  }
  return facts;
}

/**
 * A step as the plan states it: the brief it sends, and the setup it runs
 * under. Nothing here is editable — the plan is where a step is read, and the
 * plan editor is the one place it is written, so the same field can never be
 * changed from two screens that disagree.
 */
function StepReading({
  serverId,
  cwd,
  step,
}: {
  serverId: string;
  cwd: string | null;
  step: Step;
}): ReactElement {
  const { t } = useTranslation();
  const [briefOpen, setBriefOpen] = useState(false);
  const [briefClamped, setBriefClamped] = useState(false);
  const toggleBrief = useCallback(() => setBriefOpen((current) => !current), []);
  // The clamp is what says whether there is more to show: a brief that fits asks
  // nothing of the reader.
  const handleBriefLayout = useCallback((event: NativeSyntheticEvent<TextLayoutEventData>) => {
    if (event.nativeEvent.lines.length >= STEP_BRIEF_LINES) setBriefClamped(true);
  }, []);
  const snapshot = useProvidersSnapshot(serverId, { cwd });
  const facts = buildStepFacts({ step, entries: snapshot.entries, t });
  return (
    <View style={styles.stepReading}>
      <Text
        style={styles.stepBrief}
        numberOfLines={briefOpen ? undefined : STEP_BRIEF_LINES}
        onTextLayout={handleBriefLayout}
        testID={`task-detail-step-brief-${step.id}`}
      >
        {step.prompt}
      </Text>
      {briefClamped ? (
        <Pressable
          onPress={toggleBrief}
          hitSlop={SPACING[1]}
          testID={`task-detail-step-brief-toggle-${step.id}`}
        >
          <Text style={styles.stepBriefToggle}>{briefOpen ? "Show less" : "Show more"}</Text>
        </Pressable>
      ) : null}
      <View style={styles.metaRows}>
        {facts.map((fact) => (
          <View key={fact.label} style={styles.metaRow}>
            <Text style={styles.metaLabel}>{fact.label}</Text>
            <Text style={styles.metaValue} numberOfLines={2}>
              {fact.value}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}

/** A step's own screen on compact: the brief, the facts, and the actions the
 * last run allows — the same content the desktop row expands in place. */
function TaskStepSurface({
  serverId,
  cwd,
  step,
  disabled,
  onAct,
  onOpenAgent,
}: {
  serverId: string;
  cwd: string | null;
  step: Step;
  disabled: boolean;
  onAct: (stepId: string, action: TaskStepAction) => void;
  onOpenAgent: (input: { workspaceId: string; agentId: string }) => void;
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
      <StepReading serverId={serverId} cwd={cwd} step={step} />
      <View style={styles.metaRow}>
        <Text style={styles.metaLabel}>Status</Text>
        <Text style={styles.metaValue}>{t(`tasks.detail.stepStatus.${status}`)}</Text>
      </View>
      {error ? <Text style={styles.rowError}>{error}</Text> : null}
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
  const [isAdding, setIsAdding] = useState(subtasks.length === 0);
  const startAdding = useCallback(() => setIsAdding(true), []);

  return (
    <DetailSection title="Subtasks" testID="task-detail-subtasks">
      <View style={styles.card}>
        {subtasks.map((subtask, index) => (
          <SubtaskRow
            key={subtask.id}
            subtask={subtask}
            project={projectsById.get(subtask.projectId)}
            execution={executionByTaskId?.get(subtask.id)}
            withBorder={index > 0}
            isReviewing={isReviewing}
            onReview={onReview}
            onOpenAgent={onOpenAgent}
          />
        ))}
        {isAdding ? (
          <View style={[styles.subtaskDraft, subtasks.length > 0 ? styles.rowBorder : null]}>
            <View style={styles.subtaskDraftRow}>
              <AdaptiveTextInput
                initialValue={draft.title}
                resetKey={draftResetKey}
                onChangeText={handleTitle}
                onSubmitEditing={onCreate}
                placeholder="What should the subtask deliver?"
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
          </View>
        ) : (
          <Pressable
            onPress={startAdding}
            accessibilityRole="button"
            style={[styles.row, styles.addRow, subtasks.length > 0 ? styles.rowBorder : null]}
            testID="task-detail-subtask-open"
          >
            <ThemedPlus size={ICON_SIZE.sm} uniProps={extraMutedIconMapping} />
            <Text style={styles.addRowLabel}>Add subtask</Text>
          </Pressable>
        )}
      </View>
    </DetailSection>
  );
}

/** One subtask: its own status and live state as a row, its agents and verdict
 * one press deeper — the parent's sheet is where a chain is watched. */
function SubtaskRow({
  subtask,
  project,
  execution,
  withBorder,
  isReviewing,
  onReview,
  onOpenAgent,
}: {
  subtask: Task;
  project: TaskProject | undefined;
  execution: TaskExecutionSummary | undefined;
  withBorder: boolean;
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

  return (
    <View style={withBorder ? styles.rowBorder : null} testID={`task-detail-subtask-${subtask.id}`}>
      <Pressable
        onPress={toggle}
        accessibilityRole="button"
        accessibilityLabel={`${isExpanded ? "Collapse" : "Expand"} ${subtask.title}`}
        style={[styles.row, styles.subtaskRow]}
        testID={`task-detail-subtask-toggle-${subtask.id}`}
      >
        <TaskStatusDot status={subtask.status} />
        <View style={[styles.rowContent, styles.stepTitleColumn]}>
          <Text style={styles.subtaskTitle} numberOfLines={1}>
            {subtask.title}
          </Text>
          {isExpanded ? (
            <Text style={styles.rowHint} numberOfLines={1}>
              {formatSubtaskDetail({
                subtask,
                execution,
                statusLabel: t(TASK_STATUS_LABEL_KEYS[subtask.status]),
              })}
            </Text>
          ) : null}
        </View>
        <Text style={styles.subtaskKey}>{formatTaskKey(project, subtask)}</Text>
      </Pressable>
      {isExpanded ? (
        <>
          {execution?.entries.map((entry) => (
            <AgentRow key={entry.agentId} entry={entry} onOpenAgent={onOpenAgent} />
          ))}
          {subtask.status === "in_review" ? (
            <View style={[styles.row, styles.rowBorder]}>
              <View style={styles.rowContent}>
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
  execution: TaskExecutionSummary | undefined;
  statusLabel: string;
}): string {
  const details = [input.statusLabel];
  const entry = input.execution?.entries[0];
  if (entry) {
    details.push(TASK_EXECUTION_STATE_LABELS[entry.state]);
  }
  if (input.subtask.executionSpec?.trigger === "on_unblocked") {
    details.push("starts when unblocked");
  }
  return details.join(" · ");
}

/** Where the work lands, as one more row of the automation grid: the surface is
 * automation and delivery, and a card of its own made delivery read as a second
 * kind of setting rather than the last fact about the same run. */
function TaskDeliveryRow({ task }: { task: Task }): ReactElement | null {
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
    <View style={styles.policyRow} testID="task-detail-delivery">
      <View style={styles.rowContent}>
        <Text style={styles.rowTitle}>{status}</Text>
        {task.integration.error ? (
          <Text style={styles.rowError}>{task.integration.error}</Text>
        ) : null}
      </View>
      <Text style={styles.deliveryBranch} numberOfLines={1}>
        {task.integration.branch}
      </Text>
    </View>
  );
}

function formatWorkspaceMode(step: Step): string {
  if (step.workspace.mode === "worktree") return "New worktree";
  if (step.workspace.mode === "worktree_per_agent") return "Worktree per agent";
  if (step.workspace.mode === "reuse_previous") return "Previous workspace";
  return "Existing workspace";
}

/** The one action a step's last run allows, as the plan's compact pill: it has
 * to fit the row without growing it, which the shared button does not. */
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
    <Pressable
      onPress={handlePress}
      disabled={disabled}
      accessibilityRole="button"
      hitSlop={SPACING[2]}
      style={[styles.stepActionPill, disabled ? styles.stepActionPillDisabled : null]}
      testID={`task-detail-step-${stepId}-${action}`}
    >
      <Text style={styles.stepActionLabel}>{t(`tasks.detail.stepAction.${action}`)}</Text>
    </Pressable>
  );
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
  // A leaf task asks one yes-or-no question about review, so it gets a switch.
  // Flipping it always states the answer on the task; "Use defaults" is what
  // hands the decision back to the board.
  const toggleReview = useCallback(
    (enabled: boolean) => writePolicy({ ...policy, review: enabled ? "required" : "disabled" }),
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
  // Turning review off leaves the reviewer, the rounds and the rejection target
  // with nothing to act on. They stay in place, dimmed, so the shape of the
  // surface does not change under the user when they flip review back on.
  const reviewActive = reviewMode
    ? reviewMode !== "off" && (reviewMode !== "inherit" || effectivePolicy.reviewEnabled)
    : effectivePolicy.reviewEnabled;

  // An older host cannot take a per-task policy, but the task still delivers
  // somewhere, so the delivery row survives the missing controls.
  if (!supportsExecutionPolicy) {
    return (
      <View style={styles.policyList} testID="task-detail-automation">
        <Text style={styles.policyIntroText}>
          Update this host to customize automation for individual tasks.
        </Text>
        <TaskDeliveryRow task={task} />
      </View>
    );
  }

  return (
    <View style={styles.policyList} testID="task-detail-automation">
      <View style={styles.policyIntro}>
        <Text style={styles.policyIntroText}>
          {formatAutomationIntro(effectivePolicy, reviewMode)}
        </Text>
        {trailing}
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
        <View style={styles.policyRow}>
          <View style={styles.rowContent}>
            <Text style={styles.rowTitle}>Review</Text>
          </View>
          <Switch
            value={effectivePolicy.reviewEnabled}
            onValueChange={toggleReview}
            accessibilityLabel="Review"
            style={styles.policySwitch}
            testID="task-detail-policy-review"
          />
        </View>
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
        dimmed={!reviewActive}
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
        dimmed={!reviewActive}
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
        dimmed={!reviewActive}
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
      <TaskDeliveryRow task={task} />
      {reviewActive ? null : (
        <Text style={styles.policyNote}>Rows that review turns off stay visible, dimmed.</Text>
      )}
    </View>
  );
}

/** The effective policy as the sentence the surface opens with: what the rows
 * below add up to before anyone touches them. */
function formatAutomationIntro(
  effective: ReturnType<typeof resolveTaskExecutionPolicy>,
  reviewMode: ReviewMode | null,
): string {
  let workspace = "Agents use the preset's workspace.";
  if (effective.workspace === "dedicated") {
    workspace = "Every agent works in a dedicated worktree.";
  } else if (effective.workspace === "reuse") {
    workspace = "Agents reuse the task workspace.";
  }
  if (reviewMode && reviewMode !== "inherit") {
    const review =
      reviewMode === "off"
        ? "No review is required."
        : `Review covers ${REVIEW_MODE_LABELS[reviewMode].toLowerCase()}.`;
    return `${workspace} ${review}`;
  }
  if (!effective.reviewEnabled) return `${workspace} No review is required.`;
  const rounds = effective.maxReviewIterations === 1 ? "round" : "rounds";
  return `${workspace} Review is required, up to ${effective.maxReviewIterations} correction ${rounds}.`;
}

function PolicySelect<T extends string>({
  label,
  value,
  options,
  selected,
  onSelect,
  dimmed = false,
  testID,
}: {
  label: string;
  value: string;
  options: readonly { id: T; label: string }[];
  selected: T;
  onSelect: (value: T) => void;
  /** Nothing this row sets applies right now: it stays readable but inert. */
  dimmed?: boolean;
  testID: string;
}): ReactElement {
  return (
    <View style={[styles.policyRow, dimmed ? styles.policyRowDimmed : null]}>
      <View style={styles.rowContent}>
        <Text style={styles.rowTitle}>{label}</Text>
      </View>
      <DropdownMenu>
        <DropdownTrigger disabled={dimmed} testID={testID}>
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
    <View style={[styles.row, withBorder ? styles.rowBorder : null]}>
      <View style={styles.rowContent}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {task.title}
        </Text>
        <Text style={styles.rowHint}>
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
      style={[styles.row, styles.rowBorder]}
      testID={`task-detail-agent-${entry.agentId}`}
    >
      <View style={styles.agentIdentity}>
        <TaskExecutionStateDot state={entry.state} />
        <View style={styles.rowContent}>
          <Text style={styles.rowTitle} numberOfLines={1}>
            {name}
          </Text>
          <Text style={styles.rowHint} numberOfLines={1}>
            {detail}
          </Text>
        </View>
      </View>
      <ThemedChevronRight size={ICON_SIZE.sm} uniProps={mutedIconMapping} />
    </Pressable>
  );
}

/**
 * The agents of the task in the rail: whoever can still change state, or is
 * waiting on a person, gets a line. Anything settled collapses to one count —
 * a finished agent is history, and history should not push the live work down.
 */
function TaskRailAgents({
  groups,
  onOpenAgent,
}: {
  groups: readonly TaskExecutionWorkspaceGroup[];
  onOpenAgent: (input: { workspaceId: string; agentId: string }) => void;
}): ReactElement | null {
  const { t } = useTranslation();
  const [showFinished, setShowFinished] = useState(false);
  const toggleFinished = useCallback(() => setShowFinished((current) => !current), []);
  const entries = useMemo(() => groups.flatMap((group) => group.entries), [groups]);
  const workspaceNameById = useMemo(
    () => new Map(groups.map((group) => [group.workspaceId, group.workspaceName])),
    [groups],
  );
  if (entries.length === 0) {
    return null;
  }
  const open = entries.filter((entry) => entry.state !== "done");
  const finished = entries.filter((entry) => entry.state === "done");
  const liveCount = entries.filter((entry) =>
    TASK_EXECUTION_LIVE_STATES.includes(entry.state),
  ).length;
  const summary = [
    liveCount > 0 ? `${liveCount} live` : null,
    finished.length > 0 ? `${finished.length} done` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");
  const shown = showFinished ? [...open, ...finished] : open;
  return (
    <View style={styles.railGroup} testID="task-detail-rail-agents">
      <View style={styles.railGroupHeader}>
        <Text style={styles.railHeading}>{t("tasks.detail.agentsHeading")}</Text>
        {summary ? <Text style={styles.railHeading}>{summary}</Text> : null}
      </View>
      {shown.map((entry) => (
        <TaskRailAgent
          key={entry.agentId}
          entry={entry}
          workspaceName={workspaceNameById.get(entry.workspaceId) ?? entry.workspaceName}
          onOpenAgent={onOpenAgent}
        />
      ))}
      {finished.length > 0 && !showFinished ? (
        <Pressable
          onPress={toggleFinished}
          accessibilityRole="button"
          hitSlop={SPACING[1]}
          style={styles.railFact}
          testID="task-detail-rail-agents-finished"
        >
          <ThemedCheck size={ICON_SIZE.sm} uniProps={extraMutedIconMapping} />
          <Text style={styles.railFinished}>{finished.length} finished</Text>
          <View style={styles.railFactSpacer} />
          <ThemedChevronDown size={ICON_SIZE.sm} uniProps={extraMutedIconMapping} />
        </Pressable>
      ) : null}
      {finished.length > 0 && showFinished ? (
        <Pressable
          onPress={toggleFinished}
          accessibilityRole="button"
          hitSlop={SPACING[1]}
          style={styles.railFact}
          testID="task-detail-rail-agents-finished"
        >
          <ThemedCheck size={ICON_SIZE.sm} uniProps={extraMutedIconMapping} />
          <Text style={styles.railFinished}>Hide finished</Text>
          <View style={styles.railFactSpacer} />
          <ThemedChevronUp size={ICON_SIZE.sm} uniProps={extraMutedIconMapping} />
        </Pressable>
      ) : null}
    </View>
  );
}

/** What the agent is doing, as the one glyph the rail reads by: it is running,
 * it waits for a person, it broke, or it is over. */
function TaskRailAgentIcon({ state }: { state: TaskExecutionState }): ReactElement {
  if (state === "running" || state === "starting") {
    return <ThemedPlay size={ICON_SIZE.sm} uniProps={runningIconMapping} />;
  }
  if (state === "needs_input") {
    return <ThemedCircleAlert size={ICON_SIZE.sm} uniProps={warningIconMapping} />;
  }
  if (state === "attention" || state === "step_complete") {
    return <ThemedEye size={ICON_SIZE.sm} uniProps={warningIconMapping} />;
  }
  if (state === "failed") {
    return <ThemedCircleX size={ICON_SIZE.sm} uniProps={dangerIconMapping} />;
  }
  return <ThemedCheck size={ICON_SIZE.sm} uniProps={extraMutedIconMapping} />;
}

/**
 * One agent as two lines: who it is and how long since it moved, then either
 * what it waits for or where it works. The state it is in decides which,
 * because an agent that needs a person should say so where the eye lands.
 */
function TaskRailAgent({
  entry,
  workspaceName,
  onOpenAgent,
}: {
  entry: TaskExecutionEntry;
  workspaceName: string;
  onOpenAgent: (input: { workspaceId: string; agentId: string }) => void;
}): ReactElement {
  const { t } = useTranslation();
  const name = entry.title ?? resolveProviderLabel(entry.provider);
  const handlePress = useCallback(
    () => onOpenAgent({ workspaceId: entry.workspaceId, agentId: entry.agentId }),
    [entry.agentId, entry.workspaceId, onOpenAgent],
  );
  const needsPerson = entry.state === "attention" || entry.state === "step_complete";
  const failed = entry.state === "failed" || entry.state === "needs_input";
  const elapsed =
    entry.updatedAtMs === null ? null : formatCompactTimeAgo(new Date(entry.updatedAtMs));
  const role = entry.role === "reviewer" ? `${t("tasks.detail.reviewerBadge")} · ` : "";
  return (
    <Pressable
      onPress={handlePress}
      accessibilityRole="button"
      hitSlop={SPACING[1]}
      style={styles.railAgent}
      testID={`task-detail-agent-${entry.agentId}`}
    >
      <TaskRailAgentIcon state={entry.state} />
      <View style={styles.railAgentBody}>
        <View style={styles.railAgentTitleRow}>
          <Text style={styles.railDetailLink} numberOfLines={1}>
            {name}
          </Text>
          {elapsed ? <Text style={styles.railElapsed}>{elapsed}</Text> : null}
        </View>
        <Text
          style={[
            styles.railAgentDetail,
            needsPerson ? styles.railAgentDetailAttention : null,
            failed ? styles.railAgentDetailFailed : null,
          ]}
          numberOfLines={1}
        >
          {needsPerson || failed
            ? `${role}${TASK_EXECUTION_STATE_LABELS[entry.state]}`
            : `${role}${resolveProviderLabel(entry.provider)} · ${workspaceName}`}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  section: {
    gap: theme.spacing[2],
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
  },
  sectionTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
  },
  card: {
    backgroundColor: theme.colors.surface1,
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    overflow: "hidden",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: theme.spacing[3],
  },
  rowBorder: {
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
  },
  rowContent: {
    flex: 1,
    minWidth: 0,
    marginRight: theme.spacing[3],
  },
  rowTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  rowHint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    marginTop: theme.spacing[1],
  },
  rowError: {
    color: theme.colors.statusDanger,
    fontSize: theme.fontSize.xs,
    marginTop: theme.spacing[1],
  },
  taskKey: {
    color: theme.colors.foregroundMuted,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
    lineHeight: 16,
  },
  headerBody: {
    gap: theme.spacing[3],
  },
  taskKeyBadge: {
    flexGrow: 0,
    flexShrink: 0,
    color: theme.colors.foregroundMuted,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
    lineHeight: 16,
    paddingHorizontal: theme.spacing[1.5],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.surface2,
  },
  headerIdentityRow: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  desktopSplitContent: {
    padding: 0,
    gap: 0,
    flexGrow: 1,
    backgroundColor: theme.colors.surface0,
  },
  desktopSplit: {
    flexDirection: "row",
    alignItems: "stretch",
    flexShrink: 1,
    minHeight: DESKTOP_SPLIT_MIN_HEIGHT,
  },
  desktopLeftPane: {
    flex: 1,
    minWidth: 0,
    minHeight: 0,
  },
  desktopComposer: {
    flexGrow: 0,
    flexShrink: 0,
    flexDirection: "row",
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
  },
  desktopPaneScroll: {
    flexShrink: 1,
    minHeight: 0,
  },
  desktopPaneScrollContent: {
    flexGrow: 1,
  },
  desktopPaneContent: {
    padding: theme.spacing[4],
  },
  rail: {
    width: DETAIL_RAIL_WIDTH,
    flexGrow: 0,
    flexShrink: 0,
    minHeight: 0,
    borderLeftWidth: theme.borderWidth[1],
    borderLeftColor: theme.colors.borderAccent,
    backgroundColor: theme.colors.surface1,
  },
  railContent: {
    padding: theme.spacing[4],
    gap: RAIL_GROUP_GAP,
  },
  railGroup: {
    gap: theme.spacing[2],
  },
  railGroupHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  railHeading: {
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.xs,
  },
  railChips: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[1.5],
  },
  railFact: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minWidth: 0,
  },
  railFactSpacer: {
    flex: 1,
  },
  railElapsed: {
    color: theme.colors.foregroundExtraMuted,
    fontFamily: theme.fontFamily.mono,
    fontSize: STEP_DURATION_FONT_SIZE,
  },
  railFinished: {
    color: theme.colors.foregroundExtraMuted,
    fontSize: DETAIL_TEXT_SIZE,
  },
  railAgent: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[2],
    minWidth: 0,
  },
  railAgentBody: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing[0.5],
  },
  railAgentTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  railAgentDetail: {
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.xs,
  },
  railAgentDetailAttention: {
    color: theme.colors.statusWarning,
  },
  railAgentDetailFailed: {
    color: theme.colors.statusDanger,
  },
  railDetail: {
    flexShrink: 1,
    minWidth: 0,
    color: theme.colors.foregroundMuted,
    fontSize: DETAIL_TEXT_SIZE,
  },
  railDetailLink: {
    flexShrink: 1,
    minWidth: 0,
    color: theme.colors.foreground,
    fontSize: DETAIL_TEXT_SIZE,
  },
  sectionHint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  headerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  headerMenuTrigger: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.md,
  },
  bannerStack: {
    gap: theme.spacing[2],
  },
  banner: {
    gap: theme.spacing[3],
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderLeftWidth: 2,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface1,
    padding: theme.spacing[3],
  },
  bannerBlocked: {
    borderLeftColor: theme.colors.statusDanger,
  },
  bannerReview: {
    borderLeftColor: theme.colors.statusWarning,
  },
  bannerHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  bannerCopy: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing[0.5],
  },
  bannerTitle: {
    flexShrink: 1,
    minWidth: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  bannerHint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  bannerHintBlock: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  stepTrailing: {
    flexGrow: 0,
    flexShrink: 0,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
  },
  stepStatusSlot: {
    width: STEP_STATUS_WIDTH,
    flexGrow: 0,
    flexShrink: 0,
    alignItems: "flex-end",
  },
  stepDot: {
    width: 8,
    height: 8,
    borderRadius: theme.borderRadius.full,
  },
  stepDotPending: {
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.surface3,
  },
  stepDotActive: {
    backgroundColor: theme.colors.statusDotRunning,
  },
  stepDotSucceeded: {
    backgroundColor: theme.colors.statusDotSuccess,
  },
  stepDotFailed: {
    backgroundColor: theme.colors.statusDotDanger,
  },
  stepDotReview: {
    backgroundColor: theme.colors.statusDotWarning,
  },
  subtaskDraft: {
    padding: theme.spacing[3],
    gap: theme.spacing[2],
  },
  subtaskDraftRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  subtaskRow: {
    gap: theme.spacing[2],
  },
  subtaskTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    lineHeight: 20,
  },
  subtaskKey: {
    flexGrow: 0,
    flexShrink: 0,
    color: theme.colors.foregroundExtraMuted,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
  },
  stepActionPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.borderAccent,
    borderRadius: theme.borderRadius.md,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
  },
  stepActionPillDisabled: {
    opacity: 0.5,
  },
  stepActionLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    lineHeight: 15,
  },
  stepModelTrigger: {
    flexShrink: 1,
    minWidth: 0,
  },
  stepChipRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[2],
    minWidth: 0,
    flexShrink: 1,
  },
  stepChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.borderAccent,
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface1,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
  },
  stepChipLabel: {
    color: theme.colors.foreground,
    fontSize: DETAIL_TEXT_SIZE,
  },
  stepStatusActive: {
    color: theme.colors.statusDotRunning,
  },
  planForm: {
    gap: theme.spacing[3],
  },
  planFormSteps: {
    gap: theme.spacing[3],
  },
  planFormError: {
    color: theme.colors.statusDanger,
    fontSize: theme.fontSize.sm,
  },
  planAddStep: {
    alignSelf: "flex-start",
  },
  /** What the plan does when it is saved, on one closing row: the switch states
   * the plan's own behaviour, the two buttons end the edit. */
  planActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingTop: theme.spacing[3],
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
  },
  planContinuation: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  headerTitleBlock: {
    paddingHorizontal: theme.spacing[6],
  },
  headerTitleInput: {
    width: "100%",
    minWidth: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
    lineHeight: 22,
    textAlign: "left",
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    marginVertical: -theme.spacing[1],
    marginHorizontal: -theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: "transparent",
  },
  headerTitleEditing: {
    backgroundColor: theme.colors.surface2,
    borderColor: theme.colors.borderAccent,
  },
  chipRow: {
    paddingHorizontal: theme.spacing[6],
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[1.5],
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
    paddingHorizontal: theme.spacing[4],
    flexDirection: "row",
    alignItems: "stretch",
    gap: theme.spacing[3],
  },
  compactTabBar: {
    backgroundColor: theme.colors.surface1,
  },
  desktopTabBar: {
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.surface2,
    paddingHorizontal: theme.spacing[4] - TAB_HIT_PADDING,
  },
  tab: {
    justifyContent: "center",
    paddingHorizontal: TAB_HIT_PADDING,
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
    gap: theme.spacing[2],
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
  metaRows: {
    gap: theme.spacing[2],
    paddingTop: theme.spacing[3],
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
  },
  metaRow: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: theme.spacing[3],
  },
  metaLabel: {
    width: META_LABEL_WIDTH,
    flexGrow: 0,
    flexShrink: 0,
    color: theme.colors.foregroundExtraMuted,
    fontSize: DETAIL_TEXT_SIZE,
    lineHeight: META_LINE_HEIGHT,
  },
  metaValue: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foregroundMuted,
    fontSize: DETAIL_TEXT_SIZE,
    lineHeight: META_LINE_HEIGHT,
  },
  planEmpty: {
    gap: theme.spacing[2],
    alignItems: "flex-start",
  },
  planStepRow: {
    gap: theme.spacing[2],
  },
  stepTitleColumn: {
    marginRight: 0,
  },
  planStepOpen: {
    backgroundColor: theme.colors.surface2,
  },
  stepExpanded: {
    gap: theme.spacing[3],
    paddingLeft: theme.spacing[8],
    paddingRight: theme.spacing[3],
    paddingBottom: theme.spacing[3],
  },
  stepExpandedFooter: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  stepReading: {
    gap: theme.spacing[2],
  },
  stepBrief: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    lineHeight: 20,
  },
  stepBriefToggle: {
    alignSelf: "flex-start",
    color: theme.colors.accentBright,
    fontSize: DETAIL_TEXT_SIZE,
  },
  stepBriefInput: {
    minHeight: 72,
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.borderAccent,
    backgroundColor: theme.colors.surface1,
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
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: 20,
  },
  stepTitleActive: {
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.medium,
  },
  stepMeta: {
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.xs,
  },
  stepDuration: {
    width: STEP_DURATION_WIDTH,
    flexGrow: 0,
    flexShrink: 0,
    textAlign: "right",
    color: theme.colors.foregroundExtraMuted,
    fontFamily: theme.fontFamily.mono,
    fontSize: STEP_DURATION_FONT_SIZE,
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
  groupContent: {
    gap: RAIL_GROUP_GAP,
  },
  detailsDescriptionInput: {
    minHeight: 112,
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    fontSize: theme.fontSize.sm,
    lineHeight: 22,
    padding: theme.spacing[3],
  },
  inlineInput: {
    flex: 1,
    fontSize: theme.fontSize.sm,
  },
  /** The shared focus ring frames a field's own box. A field that is a bare row
   * in a card has none, so the ring would outline something that is not there;
   * the caret carries the focus instead. */
  actionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  deliveryBranch: {
    color: theme.colors.foregroundMuted,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
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
  activityDay: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingVertical: theme.spacing[3],
  },
  activityDayRule: {
    flex: 1,
    height: theme.borderWidth[1],
    backgroundColor: theme.colors.border,
  },
  activityDayLabel: {
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.xs,
  },
  activityEmpty: {
    paddingVertical: theme.spacing[8],
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
  policyValue: {
    color: theme.colors.foregroundMuted,
    fontSize: DETAIL_TEXT_SIZE,
  },
  policyList: {
    gap: theme.spacing[1],
  },
  policyIntro: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: theme.spacing[3],
    paddingBottom: theme.spacing[1],
  },
  policyIntroText: {
    flex: 1,
    color: theme.colors.foregroundExtraMuted,
    fontSize: DETAIL_TEXT_SIZE,
    lineHeight: META_LINE_HEIGHT,
  },
  policyRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: POLICY_ROW_PADDING,
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
  },
  policyRowDimmed: {
    opacity: 0.45,
  },
  /** The switch keeps its tap target through hitSlop, so the row does not have
   * to carry the shared control's minimum height and stand taller than the
   * rows it sits between. */
  policySwitch: {
    minHeight: 0,
  },
  policyNote: {
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.xs,
    lineHeight: META_LINE_HEIGHT,
    paddingTop: theme.spacing[1.5],
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
  addRow: {
    justifyContent: "flex-start",
    gap: theme.spacing[2],
  },
  addRowLabel: {
    color: theme.colors.foregroundExtraMuted,
    fontSize: DETAIL_TEXT_SIZE,
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
  composerSend: {
    height: COMPOSER_CONTROL_HEIGHT,
  },
}));
