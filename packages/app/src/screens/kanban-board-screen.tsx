import { useCallback, useMemo, useState, type ReactElement } from "react";
import { ScrollView, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { useRouter } from "expo-router";
import { Ellipsis } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ScreenHeader } from "@/components/headers/screen-header";
import { ScreenTitle } from "@/components/headers/screen-title";
import { SidebarMenuToggle } from "@/components/headers/menu-header";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { TaskWorkflowFormSheet } from "@/components/tasks/task-workflow-form-sheet";
import { TaskBoardSurface } from "@/components/tasks/task-board-surface";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { useTaskBoards, type AggregatedTaskBoard } from "@/hooks/use-task-boards";
import { findBoardById } from "@/tasks/aggregated-task-boards";
import { useTaskMutations } from "@/tasks/use-tasks";
import { buildKanbansRoute } from "@/utils/host-routes";
import type { Theme } from "@/styles/theme";

const ThemedEllipsis = withUnistyles(Ellipsis);
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

  const handleCreateWorkflowForTask = useCallback(
    (taskId: string) => setWorkflowTaskId(taskId),
    [],
  );
  const handleCloseWorkflowForm = useCallback(() => setWorkflowTaskId(null), []);

  const totalCount = board.tasks.length;

  // The review flag routes a green settle to In Review instead of Done, and it
  // is a property of the board — which is the tracker project.
  const reviewEnabled = project.board?.reviewEnabled === true;
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
            <DropdownMenuItem
              testID={`kanban-review-toggle-${boardId}`}
              onSelect={handleToggleReview}
            >
              {t(reviewEnabled ? "kanban.board.reviewDisable" : "kanban.board.reviewEnable")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </>
    ),
    [handleToggleReview, boardId, project.name, reviewEnabled, t],
  );

  const headerRight = useMemo(
    () => <Text style={styles.count}>{t("tasks.screen.taskCount", { count: totalCount })}</Text>,
    [t, totalCount],
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
            />
          </ScrollView>
        </View>
      </View>
      {workflowTaskId ? (
        <TaskWorkflowFormSheet
          serverId={serverId}
          taskId={workflowTaskId}
          visible
          onClose={handleCloseWorkflowForm}
        />
      ) : null}
    </View>
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
