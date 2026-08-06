import { useCallback, useMemo, useState, type ReactElement } from "react";
import { ScrollView, Text, View } from "react-native";
import { useIsFocused } from "@react-navigation/native";
import { useRouter } from "expo-router";
import { LayoutGrid } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { MenuHeader } from "@/components/headers/menu-header";
import { HostFilter } from "@/components/hosts/host-filter";
import { ALL_HOSTS_OPTION_ID } from "@/components/hosts/host-picker";
import { KanbanOverviewColumn } from "@/components/kanban/kanban-overview-column";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { useKanbans, type AggregatedKanban } from "@/hooks/use-kanbans";
import { useHosts } from "@/runtime/host-runtime";
import { buildKanbanBoardRoute } from "@/utils/host-routes";
import { resolveKanbansScreenBodyState } from "./kanbans-screen-state";

export function KanbansScreen(): ReactElement {
  const isFocused = useIsFocused();

  if (!isFocused) {
    return <View style={styles.container} />;
  }

  return <KanbansScreenContent />;
}

const EMPTY_KANBANS: AggregatedKanban[] = [];

function KanbansScreenContent(): ReactElement {
  const { t } = useTranslation();
  const router = useRouter();
  const { loadState, hostErrors, isError, refetch } = useKanbans();
  const kanbans = loadState.status === "loaded" ? loadState.data : EMPTY_KANBANS;
  const hosts = useHosts();
  const [selectedHost, setSelectedHost] = useState(ALL_HOSTS_OPTION_ID);

  const visibleKanbans = useMemo(
    () =>
      kanbans.filter(
        (kanban) => selectedHost === ALL_HOSTS_OPTION_ID || kanban.serverId === selectedHost,
      ),
    [kanbans, selectedHost],
  );

  const showHostFilter = hosts.length > 1;
  const showLoadError = isError && loadState.status !== "loaded";

  const handleOpenBoard = useCallback(
    (kanban: AggregatedKanban) => router.push(buildKanbanBoardRoute(kanban.id)),
    [router],
  );

  return (
    <View style={styles.container}>
      <MenuHeader title={t("kanban.screen.title")} />
      <KanbansScreenBody
        kanbans={visibleKanbans}
        loadState={loadState}
        hostErrors={hostErrors}
        showLoadError={showLoadError}
        showHostFilter={showHostFilter}
        hosts={hosts}
        selectedHost={selectedHost}
        onSelectHost={setSelectedHost}
        onRetry={refetch}
        multiHost={hosts.length > 1}
        onOpenBoard={handleOpenBoard}
      />
    </View>
  );
}

function KanbansScreenBody({
  kanbans,
  loadState,
  hostErrors,
  showLoadError,
  showHostFilter,
  hosts,
  selectedHost,
  onSelectHost,
  onRetry,
  multiHost,
  onOpenBoard,
}: {
  kanbans: AggregatedKanban[];
  loadState: ReturnType<typeof useKanbans>["loadState"];
  hostErrors: ReturnType<typeof useKanbans>["hostErrors"];
  showLoadError: boolean;
  showHostFilter: boolean;
  hosts: ReturnType<typeof useHosts>;
  selectedHost: string;
  onSelectHost: (serverId: string) => void;
  onRetry: () => void;
  multiHost: boolean;
  onOpenBoard: (kanban: AggregatedKanban) => void;
}): ReactElement {
  const { t } = useTranslation();
  const bodyState = resolveKanbansScreenBodyState({
    loadState,
    visibleCount: kanbans.length,
    showLoadError,
  });

  if (bodyState.kind === "loading") {
    return (
      <View style={styles.centered}>
        <LoadingSpinner size="large" color={styles.spinner.color} />
      </View>
    );
  }

  if (bodyState.kind === "load-error") {
    return (
      <View style={styles.centered}>
        <Text style={styles.message}>{t("kanban.screen.loadError")}</Text>
        <Button variant="ghost" onPress={onRetry} testID="kanbans-retry">
          {t("common.actions.retry")}
        </Button>
      </View>
    );
  }

  if (bodyState.kind === "empty") {
    return (
      <View style={styles.centered}>
        <LayoutGrid size={styles.emptyIcon.width} color={styles.emptyIcon.color} />
        <Text style={styles.emptyTitle}>{t("kanban.screen.emptyTitle")}</Text>
        <Text style={styles.emptyDescription}>{t("kanban.screen.emptyDescription")}</Text>
      </View>
    );
  }

  return (
    <View style={styles.body}>
      {showHostFilter ? (
        <View style={styles.filterRow}>
          <HostFilter
            hosts={hosts}
            selectedHost={selectedHost}
            onSelectHost={onSelectHost}
            triggerTestID="kanbans-host-filter-trigger"
          />
        </View>
      ) : null}
      {hostErrors.length > 0 ? <KanbansHostErrorsBanner errors={hostErrors} /> : null}
      <ScrollView
        horizontal
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsHorizontalScrollIndicator={false}
        testID="kanbans-list"
      >
        {kanbans.map((kanban) => (
          <KanbanOverviewColumn
            key={`${kanban.serverId}:${kanban.id}`}
            kanban={kanban}
            showHostBadge={multiHost}
            onOpenBoard={onOpenBoard}
            onOpenPlan={onOpenBoard}
          />
        ))}
      </ScrollView>
    </View>
  );
}

function KanbansHostErrorsBanner({
  errors,
}: {
  errors: ReturnType<typeof useKanbans>["hostErrors"];
}): ReactElement {
  const { t } = useTranslation();
  return (
    <View style={styles.errorsBanner}>
      {errors.map((error) => (
        <Text key={error.serverId} style={styles.errorsBannerText}>
          {t("kanban.screen.hostLoadError", { host: error.serverName })}
        </Text>
      ))}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  body: {
    flex: 1,
    minHeight: 0,
  },
  filterRow: {
    flexDirection: "row",
    paddingHorizontal: { xs: theme.spacing[3], md: theme.spacing[6] },
    paddingTop: theme.spacing[4],
  },
  centered: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    gap: theme.spacing[3],
    padding: theme.spacing[6],
  },
  scroll: {
    flex: 1,
    minHeight: 0,
  },
  scrollContent: {
    flexGrow: 1,
    flexDirection: "row",
    gap: theme.spacing[4],
    paddingHorizontal: { xs: theme.spacing[3], md: theme.spacing[6] },
    paddingTop: theme.spacing[4],
    paddingBottom: theme.spacing[6],
  },
  errorsBanner: {
    paddingHorizontal: theme.spacing[4],
    gap: theme.spacing[1],
  },
  errorsBannerText: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.xs,
  },
  message: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.lg,
    textAlign: "center",
  },
  spinner: {
    color: theme.colors.foregroundMuted,
  },
  emptyIcon: {
    color: theme.colors.foregroundMuted,
    width: theme.iconSize.lg,
  },
  emptyTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
  emptyDescription: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
    maxWidth: 320,
  },
}));
