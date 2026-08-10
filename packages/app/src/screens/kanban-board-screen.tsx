import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { StyleSheet as RNStyleSheet, Text, View } from "react-native";
import type { Task, TaskProject } from "@getpaseo/protocol/tasks/types";
import type { Step } from "@getpaseo/protocol/tasks/workflow";
import { useTranslation } from "react-i18next";
import { useRouter } from "expo-router";
import { Ellipsis, MessagesSquare } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Gesture } from "react-native-gesture-handler";
import Animated, { runOnJS, useAnimatedStyle, useSharedValue } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { useWindowDimensions } from "react-native";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { SidebarResizeHandle } from "@/components/sidebar-resize-handle";
import { resolveDesktopOrchestratorWidth } from "@/components/desktop-sidebar-layout";
import { BoardFeedPane } from "@/components/tasks/board-feed-pane";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useToast } from "@/contexts/toast-context";
import { toErrorMessage } from "@/utils/error-messages";
import { usePanelStore } from "@/stores/panel-store";
import { ScreenHeader } from "@/components/headers/screen-header";
import { ScreenTitle } from "@/components/headers/screen-title";
import { SidebarMenuToggle } from "@/components/headers/menu-header";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  type MenuPageDefinition,
} from "@/components/ui/dropdown-menu";
import { TaskPresetsSheet } from "@/components/tasks/task-presets-sheet";
import { TaskWorkflowFormSheet } from "@/components/tasks/task-workflow-form-sheet";
import { TaskBoardSurface } from "@/components/tasks/task-board-surface";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { useTaskBoards, type AggregatedTaskBoard } from "@/hooks/use-task-boards";
import { findBoardById } from "@/tasks/aggregated-task-boards";
import { useTaskMutations, useTasks } from "@/tasks/use-tasks";
import { useTaskPresets } from "@/tasks/use-task-delegate";
import { buildKanbansRoute } from "@/utils/host-routes";
import type { Theme } from "@/styles/theme";

const ThemedEllipsis = withUnistyles(Ellipsis);
const ThemedMessagesSquare = withUnistyles(MessagesSquare);
const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const foregroundIconMapping = (theme: Theme) => ({ color: theme.colors.foreground });

export function KanbanBoardScreen({
  boardId,
  initialTaskId,
  onInitialTaskHandled,
}: {
  boardId: string;
  /** Opened straight away, when the route named a card. */
  initialTaskId?: string | null;
  onInitialTaskHandled?: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const router = useRouter();
  const { loadState } = useTaskBoards();

  // The route carries the tracker project; the host it belongs to comes from the
  // loaded list, which is also what tells a stale id from one still loading.
  const board = useMemo(
    () => (loadState.status === "loaded" ? findBoardById(loadState.data, boardId) : null),
    [boardId, loadState],
  );

  const handleBack = useCallback(() => {
    if (router.canGoBack()) {
      router.back();
      return;
    }
    router.replace(buildKanbansRoute());
  }, [router]);

  if (loadState.status !== "loaded") {
    return (
      <View style={styles.container}>
        <ScreenHeader
          left={
            <>
              <SidebarMenuToggle />
              <ScreenTitle>{t("kanban.screen.title")}</ScreenTitle>
            </>
          }
          leftStyle={styles.headerLeft}
        />
        <View style={styles.centered}>
          <LoadingSpinner size="large" color={styles.spinner.color} />
        </View>
      </View>
    );
  }

  if (!board) {
    return (
      <View style={styles.container}>
        <ScreenHeader
          left={
            <>
              <SidebarMenuToggle />
              <ScreenTitle>{t("kanban.screen.title")}</ScreenTitle>
            </>
          }
          leftStyle={styles.headerLeft}
        />
        <View style={styles.centered}>
          <Text style={styles.message}>{t("kanban.screen.boardMissing")}</Text>
          <Button variant="ghost" onPress={handleBack} testID="kanban-board-back-to-overview">
            {t("kanban.screen.backToOverview")}
          </Button>
        </View>
      </View>
    );
  }

  return (
    <LoadedKanbanBoardScreen
      board={board}
      initialTaskId={initialTaskId ?? null}
      onInitialTaskHandled={onInitialTaskHandled}
    />
  );
}

function LoadedKanbanBoardScreen({
  board,
  initialTaskId,
  onInitialTaskHandled,
}: {
  board: AggregatedTaskBoard;
  initialTaskId: string | null;
  onInitialTaskHandled?: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const { serverId, project } = board;
  const boardId = project.id;
  const { configureBoard } = useTaskMutations(serverId);
  const [workflowTaskId, setWorkflowTaskId] = useState<string | null>(null);
  const [workflowEditSteps, setWorkflowEditSteps] = useState<readonly Step[] | undefined>(
    undefined,
  );
  const isCompact = useIsCompactFormFactor();
  // Desktop remembers the pane like the explorer sidebar does; compact borrows
  // the whole screen for it, so it is a sheet you summon, never a default.
  const feedOpenDesktop = usePanelStore((state) => state.orchestratorPanelOpen);
  const toggleFeedPanel = usePanelStore((state) => state.toggleOrchestratorPanel);
  const [isFeedSheetOpen, setIsFeedSheetOpen] = useState(false);
  const isFeedOpen = isCompact ? isFeedSheetOpen : feedOpenDesktop;

  const handleToggleFeed = useCallback(() => {
    if (isCompact) {
      setIsFeedSheetOpen((open) => !open);
      return;
    }
    toggleFeedPanel();
  }, [isCompact, toggleFeedPanel]);
  const handleCloseFeedSheet = useCallback(() => setIsFeedSheetOpen(false), []);

  const handleCreateWorkflowForTask = useCallback(
    (taskId: string, existingSteps?: readonly Step[]) => {
      setWorkflowTaskId(taskId);
      setWorkflowEditSteps(existingSteps);
    },
    [],
  );
  const handleCloseWorkflowForm = useCallback(() => {
    setWorkflowTaskId(null);
    setWorkflowEditSteps(undefined);
  }, []);
  const { snapshot } = useTasks(serverId);
  // A snapshot that has not arrived and a task with no workflow both read as
  // "no steps", and the editor cannot tell them apart: it builds its form once,
  // so opening it too early gives an empty create form that would replace the
  // workflow already on the card.
  const workflowSteps = useMemo(() => {
    if (workflowEditSteps !== undefined) {
      return workflowEditSteps;
    }
    if (!workflowTaskId || !snapshot) {
      return undefined;
    }
    return snapshot.workflows?.find((entry) => entry.taskId === workflowTaskId)?.steps ?? [];
  }, [snapshot, workflowEditSteps, workflowTaskId]);
  const canEditWorkflow = workflowTaskId !== null && workflowSteps !== undefined;

  const toast = useToast();
  // The review flag routes a green settle to In Review instead of Done, and it
  // is a property of the board — which is the tracker project.
  const reviewEnabled = project.board?.reviewEnabled === true;
  const { presets } = useTaskPresets(serverId);
  const [isPresetsOpen, setIsPresetsOpen] = useState(false);
  const handleOpenPresets = useCallback(() => setIsPresetsOpen(true), []);
  const handleClosePresets = useCallback(() => setIsPresetsOpen(false), []);
  const archiveOnDone = project.board?.archiveWorkspacesOnDone === true;
  const reviewOnReject = project.board?.reviewOnReject ?? "in_progress";
  const maxReviewIterations = project.board?.maxReviewIterations ?? 3;

  // A board setting that silently failed to save leaves the menu telling one
  // story and the daemon keeping another.
  const applyBoardConfig = useCallback(
    (patch: Omit<Parameters<typeof configureBoard>[0], "projectId">) => {
      void configureBoard({ projectId: project.id, ...patch }).catch((error) => {
        toast.show(toErrorMessage(error));
      });
    },
    [configureBoard, project.id, toast],
  );

  const handleSelectReviewer = useCallback(
    (presetId: string | null) => applyBoardConfig({ reviewerPresetId: presetId }),
    [applyBoardConfig],
  );

  const handleToggleReview = useCallback(
    () => applyBoardConfig({ reviewEnabled: !reviewEnabled }),
    [applyBoardConfig, reviewEnabled],
  );

  const handleToggleArchiveOnDone = useCallback(
    () => applyBoardConfig({ archiveWorkspacesOnDone: !archiveOnDone }),
    [applyBoardConfig, archiveOnDone],
  );

  const handleSelectRejectTarget = useCallback(
    (nextRejectTarget: "in_progress" | "todo" | "backlog") =>
      applyBoardConfig({ reviewOnReject: nextRejectTarget }),
    [applyBoardConfig],
  );
  const handleSelectMaxIterations = useCallback(
    (nextMaxIterations: number) => applyBoardConfig({ maxReviewIterations: nextMaxIterations }),
    [applyBoardConfig],
  );

  const boardMenuPages = useMemo<MenuPageDefinition[]>(
    () => [
      {
        id: "review-policy",
        title: "Review loop",
        content: (
          <>
            <DropdownMenuSubTrigger
              id="reviewer"
              value={reviewerLabel(project, presets, "None")}
              testID={`kanban-review-reviewer-${boardId}`}
            >
              Reviewer
            </DropdownMenuSubTrigger>
            <DropdownMenuSubTrigger
              id="reject-target"
              value={rejectTargetLabel(reviewOnReject)}
              testID={`kanban-review-reject-target-${boardId}`}
            >
              On rejection
            </DropdownMenuSubTrigger>
            <DropdownMenuSubTrigger
              id="review-iterations"
              value={String(maxReviewIterations)}
              testID={`kanban-review-iterations-${boardId}`}
            >
              Correction rounds
            </DropdownMenuSubTrigger>
          </>
        ),
      },
      {
        id: "reviewer",
        title: "Reviewer",
        content: (
          <>
            <ReviewerMenuItem
              boardId={boardId}
              presetId={null}
              label={t("tasks.detail.reviewerNone")}
              selected={project.board?.reviewerPresetId == null}
              onSelect={handleSelectReviewer}
            />
            {presets.map((preset) => (
              <ReviewerMenuItem
                key={preset.id}
                boardId={boardId}
                presetId={preset.id}
                label={preset.name}
                selected={project.board?.reviewerPresetId === preset.id}
                onSelect={handleSelectReviewer}
              />
            ))}
            {/* Without this the menu is one item long and reads as "a person is
                the only reviewer this board can have". */}
            {presets.length === 0 ? (
              <DropdownMenuLabel testID={`kanban-reviewer-${boardId}-empty`}>
                {t("tasks.detail.reviewerEmpty")}
              </DropdownMenuLabel>
            ) : null}
          </>
        ),
      },
      {
        id: "reject-target",
        title: "On rejection",
        content: (["in_progress", "todo", "backlog"] as const).map((status) => (
          <RejectTargetOption
            key={status}
            boardId={boardId}
            status={status}
            selected={reviewOnReject === status}
            onSelect={handleSelectRejectTarget}
          />
        )),
      },
      {
        id: "review-iterations",
        title: "Correction rounds",
        content: [1, 2, 3, 5, 10].map((iterations) => (
          <ReviewIterationOption
            key={iterations}
            boardId={boardId}
            iterations={iterations}
            selected={maxReviewIterations === iterations}
            onSelect={handleSelectMaxIterations}
          />
        )),
      },
    ],
    [
      boardId,
      handleSelectMaxIterations,
      handleSelectRejectTarget,
      handleSelectReviewer,
      maxReviewIterations,
      presets,
      project,
      reviewOnReject,
      t,
    ],
  );

  const headerLeft = useMemo(
    () => (
      <>
        <SidebarMenuToggle />
        <ScreenTitle>{project.name}</ScreenTitle>
        <DropdownMenu compactMode="sheet">
          <DropdownMenuTrigger
            style={styles.menuTrigger}
            testID={`kanban-board-menu-${boardId}`}
            accessibilityRole="button"
            accessibilityLabel={t("kanban.board.menu")}
          >
            {({ hovered, open }) => (
              <ThemedEllipsis
                size={16}
                uniProps={hovered || open ? foregroundIconMapping : mutedIconMapping}
              />
            )}
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            width={220}
            pages={boardMenuPages}
            testID={`kanban-board-menu-content-${boardId}`}
            sheetTitle={t("kanban.board.menu")}
          >
            <DropdownMenuItem testID={`kanban-presets-${boardId}`} onSelect={handleOpenPresets}>
              {t("tasks.presets.menu")}
            </DropdownMenuItem>
            <DropdownMenuItem
              testID={`kanban-review-toggle-${boardId}`}
              onSelect={handleToggleReview}
              selected={reviewEnabled}
              showSelectedCheck
            >
              {t("kanban.board.reviewRequire")}
            </DropdownMenuItem>
            <DropdownMenuItem
              testID={`kanban-archive-toggle-${boardId}`}
              onSelect={handleToggleArchiveOnDone}
              selected={archiveOnDone}
              showSelectedCheck
            >
              {t("kanban.board.archiveOnDone")}
            </DropdownMenuItem>
            {reviewEnabled ? (
              <DropdownMenuSubTrigger
                id="review-policy"
                value={`${maxReviewIterations} rounds`}
                indicator={project.board?.reviewerPresetId != null}
                testID={`kanban-review-policy-${boardId}`}
              >
                Default review loop
              </DropdownMenuSubTrigger>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </>
    ),
    [
      archiveOnDone,
      boardMenuPages,
      boardId,
      handleOpenPresets,
      handleToggleArchiveOnDone,
      handleToggleReview,
      maxReviewIterations,
      project.board?.reviewerPresetId,
      project.name,
      reviewEnabled,
      t,
    ],
  );

  const headerRight = useMemo(
    () => (
      <Button
        variant="ghost"
        size="xs"
        onPress={handleToggleFeed}
        accessibilityLabel={t("tasks.feed.toggle")}
        testID="board-feed-toggle"
      >
        <ThemedMessagesSquare
          size={16}
          uniProps={isFeedOpen ? foregroundIconMapping : mutedIconMapping}
        />
      </Button>
    ),
    [handleToggleFeed, isFeedOpen, t],
  );

  const feedSheetHeader = useMemo(() => ({ title: t("tasks.feed.toggle") }), [t]);

  const [feedTaskId, setFeedTaskId] = useState<string | null>(initialTaskId ?? null);
  const handleOpenFeedTask = useCallback((taskId: string) => setFeedTaskId(taskId), []);
  const handleFeedTaskHandled = useCallback(() => {
    setFeedTaskId(null);
    if (initialTaskId) {
      onInitialTaskHandled?.();
    }
  }, [initialTaskId, onInitialTaskHandled]);
  // On a phone the feed is a sheet over the board, so it has to close before the
  // task it names can be read.
  const handleOpenFeedTaskFromSheet = useCallback(
    (taskId: string) => {
      handleCloseFeedSheet();
      setFeedTaskId(taskId);
    },
    [handleCloseFeedSheet],
  );

  return (
    <View style={styles.container}>
      <View style={styles.row}>
        <View style={styles.centerColumn}>
          <ScreenHeader left={headerLeft} right={headerRight} leftStyle={styles.headerLeft} />
          <View style={styles.scroll} testID={`kanban-board-${boardId}`}>
            <TaskBoardSurface
              serverId={serverId}
              paseoProjectId={project.paseoProjectId ?? ""}
              trackerProjectId={project.id}
              projectDisplayName={project.name}
              onCreateWorkflowForTask={handleCreateWorkflowForTask}
              requestedTaskId={feedTaskId}
              onRequestedTaskHandled={handleFeedTaskHandled}
            />
          </View>
        </View>
        {!isCompact && feedOpenDesktop ? (
          <FeedSidebar
            serverId={serverId}
            project={project}
            tasks={board.tasks}
            onOpenTask={handleOpenFeedTask}
          />
        ) : null}
      </View>
      {isCompact ? (
        <AdaptiveModalSheet
          header={feedSheetHeader}
          visible={isFeedSheetOpen}
          onClose={handleCloseFeedSheet}
          testID="board-feed-sheet"
        >
          <BoardFeedPane
            serverId={serverId}
            project={project}
            tasks={board.tasks}
            onOpenTask={handleOpenFeedTaskFromSheet}
          />
        </AdaptiveModalSheet>
      ) : null}
      <TaskPresetsSheet
        serverId={serverId}
        paseoProjectId={project.paseoProjectId}
        visible={isPresetsOpen}
        onClose={handleClosePresets}
      />
      {canEditWorkflow && workflowTaskId ? (
        <TaskWorkflowFormSheet
          serverId={serverId}
          taskId={workflowTaskId}
          paseoProjectId={project.paseoProjectId}
          existingSteps={workflowSteps}
          visible
          onClose={handleCloseWorkflowForm}
        />
      ) : null}
    </View>
  );
}

function reviewerLabel(
  project: TaskProject,
  presets: readonly { id: string; name: string }[],
  noneLabel: string,
): string {
  const presetId = project.board?.reviewerPresetId;
  return presets.find((preset) => preset.id === presetId)?.name ?? noneLabel;
}

function rejectTargetLabel(status: "in_progress" | "todo" | "backlog"): string {
  if (status === "in_progress") return "Working";
  if (status === "todo") return "Todo";
  return "Backlog";
}

function RejectTargetOption({
  boardId,
  status,
  selected,
  onSelect,
}: {
  boardId: string;
  status: "in_progress" | "todo" | "backlog";
  selected: boolean;
  onSelect: (status: "in_progress" | "todo" | "backlog") => void;
}): ReactElement {
  const handleSelect = useCallback(() => onSelect(status), [onSelect, status]);
  return (
    <DropdownMenuItem
      selected={selected}
      showSelectedCheck
      testID={`kanban-review-reject-${boardId}-${status}`}
      onSelect={handleSelect}
    >
      {rejectTargetLabel(status)}
    </DropdownMenuItem>
  );
}

function ReviewIterationOption({
  boardId,
  iterations,
  selected,
  onSelect,
}: {
  boardId: string;
  iterations: number;
  selected: boolean;
  onSelect: (iterations: number) => void;
}): ReactElement {
  const handleSelect = useCallback(() => onSelect(iterations), [iterations, onSelect]);
  return (
    <DropdownMenuItem
      selected={selected}
      showSelectedCheck
      testID={`kanban-review-iterations-${boardId}-${iterations}`}
      onSelect={handleSelect}
    >
      {iterations}
    </DropdownMenuItem>
  );
}

/** Which agent reads the work when a card reaches review, or nobody. */
function ReviewerMenuItem({
  boardId,
  presetId,
  label,
  selected,
  onSelect,
}: {
  boardId: string;
  presetId: string | null;
  label: string;
  selected: boolean;
  onSelect: (presetId: string | null) => void;
}): ReactElement {
  const handleSelect = useCallback(() => onSelect(presetId), [onSelect, presetId]);
  return (
    <DropdownMenuItem
      testID={`kanban-reviewer-${boardId}-${presetId ?? "none"}`}
      onSelect={handleSelect}
      selected={selected}
      showSelectedCheck
    >
      {label}
    </DropdownMenuItem>
  );
}

/**
 * The explorer sidebar's shape, for the board: width owned by the panel store,
 * clamped against the viewport, resized by the same edge gesture. Mounted only
 * while open, so reopening refetches what the feed shows.
 */
function FeedSidebar({
  serverId,
  project,
  tasks,
  onOpenTask,
}: {
  serverId: string;
  project: TaskProject;
  tasks: readonly Task[];
  onOpenTask: (taskId: string) => void;
}): ReactElement {
  const insets = useSafeAreaInsets();
  const feedWidth = usePanelStore((state) => state.orchestratorWidth);
  const setFeedWidth = usePanelStore((state) => state.setOrchestratorWidth);
  const { width: viewportWidth } = useWindowDimensions();
  const visibleWidth = resolveDesktopOrchestratorWidth({
    requestedWidth: feedWidth,
    viewportWidth,
  });
  const startWidthRef = useRef(visibleWidth);
  const resizeWidth = useSharedValue(visibleWidth);
  const [resizePressed, setResizePressed] = useState(false);
  const showResizeGrip = useCallback(() => setResizePressed(true), []);
  const hideResizeGrip = useCallback(() => setResizePressed(false), []);

  useEffect(() => {
    resizeWidth.value = visibleWidth;
  }, [resizeWidth, visibleWidth]);

  const resizeGesture = useMemo(
    () =>
      Gesture.Pan()
        .enabled(true)
        .hitSlop({ left: 8, right: 8, top: 0, bottom: 0 })
        .onBegin(() => {
          scheduleOnRN(showResizeGrip);
        })
        .onStart(() => {
          startWidthRef.current = visibleWidth;
          resizeWidth.value = visibleWidth;
        })
        .onUpdate((event) => {
          const newWidth = startWidthRef.current - event.translationX;
          resizeWidth.value = resolveDesktopOrchestratorWidth({
            requestedWidth: newWidth,
            viewportWidth,
          });
        })
        .onEnd(() => {
          runOnJS(setFeedWidth)(resizeWidth.value);
        })
        .onFinalize(() => {
          scheduleOnRN(hideResizeGrip);
        }),
    [hideResizeGrip, resizeWidth, setFeedWidth, showResizeGrip, viewportWidth, visibleWidth],
  );

  const resizeAnimatedStyle = useAnimatedStyle(() => ({ width: resizeWidth.value }));

  return (
    <Animated.View
      style={[feedSidebarStaticStyles.container, resizeAnimatedStyle, { paddingTop: insets.top }]}
    >
      <View style={styles.feedPane}>
        <SidebarResizeHandle
          edge="left"
          gesture={resizeGesture}
          pressed={resizePressed}
          testID="board-feed-resize-handle"
        />
        <BoardFeedPane
          serverId={serverId}
          project={project}
          tasks={tasks}
          onOpenTask={onOpenTask}
        />
      </View>
    </Animated.View>
  );
}

const feedSidebarStaticStyles = RNStyleSheet.create({
  container: {
    position: "relative" as const,
  },
});

const styles = StyleSheet.create((theme) => ({
  feedPane: {
    flex: 1,
    borderLeftWidth: theme.borderWidth[1],
    borderLeftColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
  },
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  headerLeft: {
    gap: theme.spacing[2],
  },
  headerTrailing: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  menuTrigger: {
    width: 24,
    height: 24,
    alignItems: "center",
    justifyContent: "center",
  },
  row: {
    flex: 1,
    minHeight: 0,
    flexDirection: "row",
  },
  centerColumn: {
    flex: 1,
    minWidth: 0,
  },
  scroll: {
    flex: 1,
    minHeight: 0,
  },
  centered: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    gap: theme.spacing[3],
    padding: theme.spacing[6],
  },
  message: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
  spinner: {
    color: theme.colors.foregroundMuted,
  },
}));
