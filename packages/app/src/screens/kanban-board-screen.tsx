import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { ScrollView, Text, View } from "react-native";
import type { Task, TaskProject } from "@getpaseo/protocol/tasks/types";
import { useTranslation } from "react-i18next";
import { useRouter } from "expo-router";
import { Ellipsis, MessagesSquare } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Gesture } from "react-native-gesture-handler";
import Animated, { runOnJS, useAnimatedStyle, useSharedValue } from "react-native-reanimated";
import { useWindowDimensions } from "react-native";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { SidebarResizeHandle } from "@/components/sidebar-resize-handle";
import { resolveDesktopOrchestratorWidth } from "@/components/desktop-sidebar-layout";
import { BoardFeedPane } from "@/components/tasks/board-feed-pane";
import { useIsCompactFormFactor } from "@/constants/layout";
import { usePanelStore } from "@/stores/panel-store";
import { ScreenHeader } from "@/components/headers/screen-header";
import { ScreenTitle } from "@/components/headers/screen-title";
import { SidebarMenuToggle } from "@/components/headers/menu-header";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
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

export function KanbanBoardScreen({ boardId }: { boardId: string }): ReactElement {
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

  return <LoadedKanbanBoardScreen board={board} />;
}

function LoadedKanbanBoardScreen({ board }: { board: AggregatedTaskBoard }): ReactElement {
  const { t } = useTranslation();
  const { serverId, project } = board;
  const boardId = project.id;
  const { configureBoard } = useTaskMutations(serverId);
  const [workflowTaskId, setWorkflowTaskId] = useState<string | null>(null);
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
    (taskId: string) => setWorkflowTaskId(taskId),
    [],
  );
  const handleCloseWorkflowForm = useCallback(() => setWorkflowTaskId(null), []);
  const { snapshot } = useTasks(serverId);
  const workflowSteps = useMemo(
    () =>
      workflowTaskId
        ? snapshot?.workflows?.find((entry) => entry.taskId === workflowTaskId)?.steps
        : undefined,
    [snapshot?.workflows, workflowTaskId],
  );

  const totalCount = board.tasks.length;

  // The review flag routes a green settle to In Review instead of Done, and it
  // is a property of the board — which is the tracker project.
  const reviewEnabled = project.board?.reviewEnabled === true;
  const { presets } = useTaskPresets(serverId);
  const [isPresetsOpen, setIsPresetsOpen] = useState(false);
  const handleOpenPresets = useCallback(() => setIsPresetsOpen(true), []);
  const handleClosePresets = useCallback(() => setIsPresetsOpen(false), []);
  const handleSelectReviewer = useCallback(
    (presetId: string | null) => {
      void configureBoard({ projectId: project.id, reviewerPresetId: presetId });
    },
    [configureBoard, project.id],
  );

  const handleToggleReview = useCallback(() => {
    void configureBoard({ projectId: project.id, reviewEnabled: !reviewEnabled });
  }, [configureBoard, project.id, reviewEnabled]);

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
            testID={`kanban-board-menu-content-${boardId}`}
            sheetTitle={t("kanban.board.menu")}
          >
            <DropdownMenuItem testID={`kanban-presets-${boardId}`} onSelect={handleOpenPresets}>
              {t("tasks.presets.menu")}
            </DropdownMenuItem>
            <DropdownMenuItem
              testID={`kanban-review-toggle-${boardId}`}
              onSelect={handleToggleReview}
            >
              {t(reviewEnabled ? "kanban.board.reviewDisable" : "kanban.board.reviewEnable")}
            </DropdownMenuItem>
            {reviewEnabled ? (
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
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </>
    ),
    [
      boardId,
      handleOpenPresets,
      handleSelectReviewer,
      handleToggleReview,
      presets,
      project.board?.reviewerPresetId,
      project.name,
      reviewEnabled,
      t,
    ],
  );

  const headerRight = useMemo(
    () => (
      <>
        <Text style={styles.count}>{t("tasks.screen.taskCount", { count: totalCount })}</Text>
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
      </>
    ),
    [handleToggleFeed, isFeedOpen, t, totalCount],
  );

  const feedSheetHeader = useMemo(() => ({ title: t("tasks.feed.toggle") }), [t]);

  const [feedTaskId, setFeedTaskId] = useState<string | null>(null);
  const handleOpenFeedTask = useCallback((taskId: string) => setFeedTaskId(taskId), []);
  const handleFeedTaskHandled = useCallback(() => setFeedTaskId(null), []);
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
          <ScrollView
            style={styles.scroll}
            contentContainerStyle={styles.scrollContent}
            testID={`kanban-board-${boardId}`}
          >
            <TaskBoardSurface
              serverId={serverId}
              paseoProjectId={project.paseoProjectId ?? ""}
              trackerProjectId={project.id}
              projectDisplayName={project.name}
              onCreateWorkflowForTask={handleCreateWorkflowForTask}
              requestedTaskId={feedTaskId}
              onRequestedTaskHandled={handleFeedTaskHandled}
            />
          </ScrollView>
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
      <TaskPresetsSheet serverId={serverId} visible={isPresetsOpen} onClose={handleClosePresets} />
      {workflowTaskId ? (
        <TaskWorkflowFormSheet
          serverId={serverId}
          taskId={workflowTaskId}
          existingSteps={workflowSteps}
          visible
          onClose={handleCloseWorkflowForm}
        />
      ) : null}
    </View>
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
    >
      {selected ? `✓ ${label}` : label}
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

  useEffect(() => {
    resizeWidth.value = visibleWidth;
  }, [resizeWidth, visibleWidth]);

  const resizeGesture = useMemo(
    () =>
      Gesture.Pan()
        .enabled(true)
        .hitSlop({ left: 8, right: 8, top: 0, bottom: 0 })
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
        }),
    [resizeWidth, setFeedWidth, viewportWidth, visibleWidth],
  );

  const resizeAnimatedStyle = useAnimatedStyle(() => ({ width: resizeWidth.value }));

  return (
    <Animated.View style={[styles.feedPane, resizeAnimatedStyle, { paddingTop: insets.top }]}>
      <SidebarResizeHandle edge="left" gesture={resizeGesture} testID="board-feed-resize-handle" />
      <BoardFeedPane serverId={serverId} project={project} tasks={tasks} onOpenTask={onOpenTask} />
    </Animated.View>
  );
}

const styles = StyleSheet.create((theme) => ({
  feedPane: {
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
  count: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
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
  scrollContent: {
    flexGrow: 1,
    paddingBottom: theme.spacing[6],
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
