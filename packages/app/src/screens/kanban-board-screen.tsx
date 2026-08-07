import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { ScrollView, Text, View, useWindowDimensions } from "react-native";
import { useTranslation } from "react-i18next";
import { useRouter } from "expo-router";
import { Gesture } from "react-native-gesture-handler";
import Animated, { runOnJS, useAnimatedStyle, useSharedValue } from "react-native-reanimated";
import { ArrowLeft, MessagesSquare, MoreVertical } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { ScreenHeader } from "@/components/headers/screen-header";
import { ScreenTitle } from "@/components/headers/screen-title";
import { SidebarMenuToggle } from "@/components/headers/menu-header";
import { SidebarResizeHandle } from "@/components/sidebar-resize-handle";
import { resolveDesktopOrchestratorWidth } from "@/components/desktop-sidebar-layout";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { KanbanOrchestratorPane } from "@/components/kanban/kanban-orchestrator-pane";
import { KanbanPlanFormSheet } from "@/components/kanban/kanban-plan-form-sheet";
import { TaskBoardSurface } from "@/components/tasks/task-board-surface";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useKanban, useKanbans } from "@/hooks/use-kanbans";
import { useKanbanMutations } from "@/hooks/use-kanban-mutations";
import { useKeyboardActionHandler } from "@/hooks/use-keyboard-action-handler";
import type { KeyboardActionId } from "@/keyboard/keyboard-action-dispatcher";
import { usePanelStore } from "@/stores/panel-store";
import { selectProjectBoard } from "@/tasks/task-views";
import { useTasks } from "@/tasks/use-tasks";
import { useProjectDisplayName } from "@/stores/session-store-hooks";
import { buildKanbansRoute } from "@/utils/host-routes";
import { ICON_SIZE, type Theme } from "@/styles/theme";

const ThemedArrowLeft = withUnistyles(ArrowLeft);
const ThemedMoreVertical = withUnistyles(MoreVertical);
const ThemedMessagesSquare = withUnistyles(MessagesSquare);
const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const foregroundIconMapping = (theme: Theme) => ({ color: theme.colors.foreground });

const NEW_PLAN_ACTIONS: readonly KeyboardActionId[] = ["kanban.plan.new"];

export function KanbanBoardScreen({ kanbanId }: { kanbanId: string }): ReactElement {
  const { t } = useTranslation();
  const router = useRouter();
  const { loadState } = useKanbans();

  // The board route only carries the kanban id; the host it belongs to comes from
  // the loaded list, which is also what tells a stale id from one still loading.
  const summary = useMemo(() => {
    if (loadState.status !== "loaded") {
      return null;
    }
    return loadState.data.find((kanban) => kanban.id === kanbanId) ?? null;
  }, [kanbanId, loadState]);

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

  if (!summary) {
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

  return <LoadedKanbanBoardScreen kanbanId={kanbanId} summary={summary} onBack={handleBack} />;
}

function LoadedKanbanBoardScreen({
  kanbanId,
  summary,
  onBack,
}: {
  kanbanId: string;
  summary: { serverId: string; projectId: string; name: string };
  onBack: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const { serverId } = summary;
  const isCompact = useIsCompactFormFactor();
  const { provisionOrchestrator, updateKanban } = useKanbanMutations({ serverId });
  const { kanban: detail } = useKanban({ serverId, kanbanId });
  const [isProvisioning, setIsProvisioning] = useState(false);
  const [planForm, setPlanForm] = useState<{ taskId: string | null } | null>(null);
  // Desktop remembers the pane like the explorer sidebar does; compact borrows
  // the whole screen for it, so it is a sheet you summon, never a default.
  const orchestratorOpenDesktop = usePanelStore((state) => state.orchestratorPanelOpen);
  const toggleOrchestratorPanel = usePanelStore((state) => state.toggleOrchestratorPanel);
  const [isOrchestratorSheetOpen, setIsOrchestratorSheetOpen] = useState(false);
  const isOrchestratorOpen = isCompact ? isOrchestratorSheetOpen : orchestratorOpenDesktop;

  const handleProvisionOrchestrator = useCallback(async () => {
    setIsProvisioning(true);
    try {
      await provisionOrchestrator(kanbanId);
    } finally {
      setIsProvisioning(false);
    }
  }, [kanbanId, provisionOrchestrator]);
  const handleToggleOrchestrator = useCallback(() => {
    if (isCompact) {
      setIsOrchestratorSheetOpen((open) => !open);
      return;
    }
    toggleOrchestratorPanel();
  }, [isCompact, toggleOrchestratorPanel]);
  const handleCloseOrchestratorSheet = useCallback(() => setIsOrchestratorSheetOpen(false), []);
  const handleOpenCreatePlan = useCallback(() => setPlanForm({ taskId: null }), []);
  const handleCreatePlanForTask = useCallback((taskId: string) => setPlanForm({ taskId }), []);
  const handleCloseCreatePlan = useCallback(() => setPlanForm(null), []);
  const handleNewPlanShortcut = useCallback(() => {
    setPlanForm({ taskId: null });
    return true;
  }, []);
  // The review flag routes a green settle to In Review instead of Done —
  // docs/tasks.md, "Automatic transitions".
  const reviewEnabled = detail?.review?.enabled === true;
  const handleToggleReview = useCallback(() => {
    void updateKanban({
      kanbanId,
      review: {
        enabled: !reviewEnabled,
        onReject: detail?.review?.onReject ?? "in_progress",
      },
    });
  }, [detail?.review?.onReject, kanbanId, reviewEnabled, updateKanban]);

  useKeyboardActionHandler({
    handlerId: `kanban-plan-new-${kanbanId}`,
    actions: NEW_PLAN_ACTIONS,
    enabled: planForm === null,
    priority: 0,
    handle: handleNewPlanShortcut,
  });

  const orchestratorSheetHeader = useMemo(
    () => ({ title: t("kanban.orchestrator.rail.heading") }),
    [t],
  );
  const projectName = useProjectDisplayName(serverId, summary.projectId);
  const { snapshot } = useTasks(serverId);
  const totalCount = useMemo(
    () => selectProjectBoard(snapshot, summary.projectId).tasks.length,
    [snapshot, summary.projectId],
  );

  const headerLeft = useMemo(
    () => (
      <>
        <SidebarMenuToggle />
        <Button
          variant="ghost"
          size="xs"
          onPress={onBack}
          accessibilityLabel={t("kanban.screen.backToOverview")}
          testID="kanban-board-back"
        >
          <ThemedArrowLeft size={ICON_SIZE.sm} uniProps={mutedIconMapping} />
        </Button>
        <ScreenTitle>{projectName ?? summary.name}</ScreenTitle>
      </>
    ),
    [onBack, projectName, summary.name, t],
  );

  const headerRight = useMemo(
    () => (
      <View style={styles.headerTrailing}>
        <Text style={styles.count}>{t("tasks.screen.taskCount", { count: totalCount })}</Text>
        <Button
          variant="ghost"
          size="xs"
          onPress={handleToggleOrchestrator}
          accessibilityLabel={t("kanban.orchestrator.pane.toggle")}
          testID="kanban-orchestrator-pane-toggle"
        >
          <ThemedMessagesSquare
            size={ICON_SIZE.sm}
            uniProps={isOrchestratorOpen ? foregroundIconMapping : mutedIconMapping}
          />
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger
            style={styles.menuTrigger}
            testID={`kanban-board-menu-${kanbanId}`}
            accessibilityRole="button"
            accessibilityLabel={t("kanban.board.menu")}
          >
            {({ hovered }) => (
              <ThemedMoreVertical
                size={ICON_SIZE.sm}
                uniProps={hovered ? foregroundIconMapping : mutedIconMapping}
              />
            )}
          </DropdownMenuTrigger>
          <DropdownMenuContent
            side="bottom"
            align="end"
            testID={`kanban-board-menu-content-${kanbanId}`}
          >
            <DropdownMenuItem
              testID={`kanban-new-plan-${kanbanId}`}
              onSelect={handleOpenCreatePlan}
            >
              {t("kanban.column.addPlan")}
            </DropdownMenuItem>
            <DropdownMenuItem
              testID={`kanban-review-toggle-${kanbanId}`}
              onSelect={handleToggleReview}
            >
              {t(reviewEnabled ? "kanban.board.reviewDisable" : "kanban.board.reviewEnable")}
            </DropdownMenuItem>
            <DropdownMenuItem
              testID={`kanban-create-orchestrator-${kanbanId}`}
              onSelect={handleProvisionOrchestrator}
              disabled={isProvisioning}
            >
              {t("kanban.board.createOrchestrator")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </View>
    ),
    [
      handleOpenCreatePlan,
      handleProvisionOrchestrator,
      handleToggleOrchestrator,
      handleToggleReview,
      isOrchestratorOpen,
      isProvisioning,
      kanbanId,
      reviewEnabled,
      t,
      totalCount,
    ],
  );

  return (
    <View style={styles.container}>
      <ScreenHeader left={headerLeft} right={headerRight} leftStyle={styles.headerLeft} />
      <View style={styles.body}>
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          testID={`kanban-board-${kanbanId}`}
        >
          <TaskBoardSurface
            serverId={serverId}
            paseoProjectId={summary.projectId}
            projectDisplayName={projectName ?? summary.name}
            onCreatePlanForTask={handleCreatePlanForTask}
          />
        </ScrollView>
        {!isCompact && orchestratorOpenDesktop ? (
          <OrchestratorSidebar serverId={serverId} kanbanId={kanbanId} />
        ) : null}
      </View>
      {isCompact ? (
        <AdaptiveModalSheet
          header={orchestratorSheetHeader}
          visible={isOrchestratorSheetOpen}
          onClose={handleCloseOrchestratorSheet}
          testID="kanban-orchestrator-sheet"
        >
          <KanbanOrchestratorPane serverId={serverId} kanbanId={kanbanId} />
        </AdaptiveModalSheet>
      ) : null}
      {planForm ? (
        <KanbanPlanFormSheet
          serverId={serverId}
          kanbanId={kanbanId}
          parentPlanId={null}
          taskId={planForm.taskId}
          visible
          onClose={handleCloseCreatePlan}
        />
      ) : null}
    </View>
  );
}

/**
 * The explorer sidebar's shape, for the board: width owned by the panel store,
 * clamped against the viewport, resized by the same edge gesture. Mounted only
 * while open, so reopening refetches what the conversation shows.
 */
function OrchestratorSidebar({
  serverId,
  kanbanId,
}: {
  serverId: string;
  kanbanId: string;
}): ReactElement {
  const orchestratorWidth = usePanelStore((state) => state.orchestratorWidth);
  const setOrchestratorWidth = usePanelStore((state) => state.setOrchestratorWidth);
  const { width: viewportWidth } = useWindowDimensions();
  const visibleWidth = resolveDesktopOrchestratorWidth({
    requestedWidth: orchestratorWidth,
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
          runOnJS(setOrchestratorWidth)(resizeWidth.value);
        }),
    [resizeWidth, setOrchestratorWidth, viewportWidth, visibleWidth],
  );

  const resizeAnimatedStyle = useAnimatedStyle(() => ({
    width: resizeWidth.value,
  }));

  return (
    <Animated.View style={[styles.orchestratorPane, resizeAnimatedStyle]}>
      <SidebarResizeHandle
        edge="left"
        gesture={resizeGesture}
        testID="kanban-orchestrator-resize-handle"
      />
      <KanbanOrchestratorPane serverId={serverId} kanbanId={kanbanId} />
    </Animated.View>
  );
}

const styles = StyleSheet.create((theme) => ({
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
  body: {
    flex: 1,
    minHeight: 0,
    flexDirection: "row",
  },
  scroll: {
    flex: 1,
    minHeight: 0,
  },
  orchestratorPane: {
    minHeight: 0,
    borderLeftWidth: theme.borderWidth[1],
    borderLeftColor: theme.colors.border,
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
