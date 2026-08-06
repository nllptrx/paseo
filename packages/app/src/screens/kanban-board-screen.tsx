import { useCallback, useMemo, useState, type ReactElement } from "react";
import { ScrollView, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { useRouter } from "expo-router";
import { ArrowLeft, MoreVertical } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { MenuHeader } from "@/components/headers/menu-header";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { KanbanBoardSurface } from "@/components/kanban/kanban-board-surface";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { useKanban, useKanbans } from "@/hooks/use-kanbans";
import { useKanbanMutations } from "@/hooks/use-kanban-mutations";
import { deriveBoard } from "@/kanban/derive-board";
import { useKanbanDraftOrder } from "@/stores/kanban-draft-order-store";
import { useProjectDisplayName } from "@/stores/session-store-hooks";
import { buildKanbansRoute } from "@/utils/host-routes";
import { ICON_SIZE, type Theme } from "@/styles/theme";

const ThemedArrowLeft = withUnistyles(ArrowLeft);
const ThemedMoreVertical = withUnistyles(MoreVertical);
const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const foregroundIconMapping = (theme: Theme) => ({ color: theme.colors.foreground });

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
  summary: { serverId: string; projectId: string; name: string; orchestrator: unknown };
  onBack: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const { serverId } = summary;
  const { provisionOrchestrator } = useKanbanMutations({ serverId });
  const [isProvisioning, setIsProvisioning] = useState(false);

  const handleProvisionOrchestrator = useCallback(async () => {
    setIsProvisioning(true);
    try {
      await provisionOrchestrator(kanbanId);
    } finally {
      setIsProvisioning(false);
    }
  }, [kanbanId, provisionOrchestrator]);
  const { kanban: detail, isLoading, isError, error, refetch } = useKanban({ serverId, kanbanId });
  const draftOrder = useKanbanDraftOrder(kanbanId);
  const projectName = useProjectDisplayName(serverId, summary.projectId);
  const totalCount = useMemo(
    () => (detail ? deriveBoard(detail, draftOrder).totalCount : 0),
    [detail, draftOrder],
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
          <Text style={styles.count}>{t("kanban.screen.planCount", { count: totalCount })}</Text>
          {summary.orchestrator ? null : (
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
                  testID={`kanban-create-orchestrator-${kanbanId}`}
                  onSelect={handleProvisionOrchestrator}
                  disabled={isProvisioning}
                >
                  {t("kanban.board.createOrchestrator")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </View>
      </View>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        testID={`kanban-board-${kanbanId}`}
      >
        <KanbanBoardSurface
          serverId={serverId}
          kanbanId={kanbanId}
          detail={detail}
          isLoading={isLoading}
          isError={isError}
          error={error}
          onRetry={refetch}
        />
      </ScrollView>
    </View>
  );
}

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
