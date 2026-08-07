import { useCallback, useMemo, useState, type ReactElement } from "react";
import { ScrollView, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { useRouter } from "expo-router";
import { ArrowLeft, MessagesSquare, MoreVertical } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { MenuHeader } from "@/components/headers/menu-header";
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
import { useKanbans } from "@/hooks/use-kanbans";
import { useKanbanMutations } from "@/hooks/use-kanban-mutations";
import { useKeyboardActionHandler } from "@/hooks/use-keyboard-action-handler";
import type { KeyboardActionId } from "@/keyboard/keyboard-action-dispatcher";
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
        <MenuHeader title={t("kanban.screen.title")} />
        <View style={styles.centered}>
          <LoadingSpinner size="large" color={styles.spinner.color} />
        </View>
      </View>
    );
  }

  if (!summary) {
    return (
      <View style={styles.container}>
        <MenuHeader title={t("kanban.screen.title")} />
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
  const { provisionOrchestrator } = useKanbanMutations({ serverId });
  const [isProvisioning, setIsProvisioning] = useState(false);
  const [isCreatingPlan, setIsCreatingPlan] = useState(false);
  // Wide layouts have room to keep the conversation open beside the board;
  // a compact one borrows the whole screen for it, so it starts closed.
  const [isOrchestratorPaneOpen, setIsOrchestratorPaneOpen] = useState(() => !isCompact);

  const handleProvisionOrchestrator = useCallback(async () => {
    setIsProvisioning(true);
    try {
      await provisionOrchestrator(kanbanId);
    } finally {
      setIsProvisioning(false);
    }
  }, [kanbanId, provisionOrchestrator]);
  const handleToggleOrchestratorPane = useCallback(
    () => setIsOrchestratorPaneOpen((open) => !open),
    [],
  );
  const handleCloseOrchestratorPane = useCallback(() => setIsOrchestratorPaneOpen(false), []);
  const handleOpenCreatePlan = useCallback(() => setIsCreatingPlan(true), []);
  const handleCloseCreatePlan = useCallback(() => setIsCreatingPlan(false), []);
  const handleNewPlanShortcut = useCallback(() => {
    setIsCreatingPlan(true);
    return true;
  }, []);

  useKeyboardActionHandler({
    handlerId: `kanban-plan-new-${kanbanId}`,
    actions: NEW_PLAN_ACTIONS,
    enabled: !isCreatingPlan,
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

  return (
    <View style={styles.container}>
      <MenuHeader title={projectName ?? summary.name} />
      <View style={styles.subHeader}>
        <Button
          variant="ghost"
          size="sm"
          leftIcon={ThemedArrowLeft}
          onPress={onBack}
          accessibilityLabel={t("kanban.screen.backToOverview")}
          testID="kanban-board-back"
        >
          {t("kanban.screen.backToOverview")}
        </Button>
        <View style={styles.subHeaderTrailing}>
          <Text style={styles.count}>{t("tasks.screen.taskCount", { count: totalCount })}</Text>
          <Button
            variant="ghost"
            size="xs"
            onPress={handleToggleOrchestratorPane}
            accessibilityLabel={t("kanban.orchestrator.pane.toggle")}
            testID="kanban-orchestrator-pane-toggle"
          >
            <ThemedMessagesSquare
              size={ICON_SIZE.sm}
              uniProps={isOrchestratorPaneOpen ? foregroundIconMapping : mutedIconMapping}
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
                testID={`kanban-create-orchestrator-${kanbanId}`}
                onSelect={handleProvisionOrchestrator}
                disabled={isProvisioning}
              >
                {t("kanban.board.createOrchestrator")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </View>
      </View>
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
          />
        </ScrollView>
        {isOrchestratorPaneOpen && !isCompact ? (
          <View style={styles.orchestratorPane}>
            <KanbanOrchestratorPane serverId={serverId} kanbanId={kanbanId} />
          </View>
        ) : null}
      </View>
      {isCompact ? (
        <AdaptiveModalSheet
          header={orchestratorSheetHeader}
          visible={isOrchestratorPaneOpen}
          onClose={handleCloseOrchestratorPane}
          testID="kanban-orchestrator-sheet"
        >
          <KanbanOrchestratorPane serverId={serverId} kanbanId={kanbanId} />
        </AdaptiveModalSheet>
      ) : null}
      {isCreatingPlan ? (
        <KanbanPlanFormSheet
          serverId={serverId}
          kanbanId={kanbanId}
          parentPlanId={null}
          visible
          onClose={handleCloseCreatePlan}
        />
      ) : null}
    </View>
  );
}

const ORCHESTRATOR_PANE_WIDTH = 320;

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  subHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: { xs: theme.spacing[3], md: theme.spacing[6] },
    paddingTop: theme.spacing[3],
  },
  subHeaderTrailing: {
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
    width: ORCHESTRATOR_PANE_WIDTH,
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
