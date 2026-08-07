import { useCallback, useMemo, useState, type ReactElement } from "react";
import { ScrollView, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { Plus } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import type { Task, TaskLabel, TaskProject, TaskStatus } from "@getpaseo/protocol/tasks/types";
import { TASK_STATUSES } from "@getpaseo/protocol/tasks/types";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { TASK_STATUS_LABEL_KEYS, TaskBoard } from "@/components/tasks/task-board";
import { MenuHeader } from "@/components/headers/menu-header";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { useHosts } from "@/runtime/host-runtime";
import {
  formatTaskKey,
  groupTasksByStatus,
  partitionTaskLabels,
  resolveTaskLabels,
  sortTasks,
} from "@/tasks/task-views";
import { useTaskMutations, useTasks, useTasksSupported } from "@/tasks/use-tasks";
import { toErrorMessage } from "@/utils/error-messages";

const ROW_LABEL_CAP = 2;
const DEFAULT_PROJECT_COLOR = "#7C6BF5";

export function TasksScreen(): ReactElement {
  const { t } = useTranslation();
  const hosts = useHosts();
  // The tracker is host-local. Until the picker exists this reads the first
  // host, which is the only one most setups have.
  const serverId = hosts[0]?.serverId ?? "";
  const supported = useTasksSupported(serverId);

  if (!serverId) {
    return <Empty title={t("tasks.screen.title")} message={t("tasks.screen.noHost")} />;
  }
  if (!supported) {
    return <Empty title={t("tasks.screen.title")} message={t("tasks.screen.unsupported")} />;
  }
  return <LoadedTasksScreen serverId={serverId} />;
}

function Empty({ title, message }: { title: string; message: string }): ReactElement {
  return (
    <View style={styles.container}>
      <MenuHeader title={title} />
      <View style={styles.centered}>
        <Text style={styles.message}>{message}</Text>
      </View>
    </View>
  );
}

function LoadedTasksScreen({ serverId }: { serverId: string }): ReactElement {
  const { t } = useTranslation();
  const { snapshot, isLoading, isError, error, refetch } = useTasks(serverId);
  const { setStatus } = useTaskMutations(serverId);
  const [isCreating, setIsCreating] = useState(false);
  // One object, two representations. The tab changes how you look at the tasks,
  // never which tasks you are looking at.
  const [view, setView] = useState<"list" | "board">("list");
  const [boardColumn, setBoardColumn] = useState<TaskStatus>("backlog");

  const projectsById = useMemo(
    () => new Map((snapshot?.projects ?? []).map((project) => [project.id, project])),
    [snapshot],
  );
  const groups = useMemo(
    () => groupTasksByStatus(sortTasks(snapshot?.tasks ?? [], "manual")),
    [snapshot],
  );
  const total = snapshot?.tasks.length ?? 0;

  const handleSelectView = useCallback((value: string) => {
    setView(value === "board" ? "board" : "list");
  }, []);
  const handleSetStatus = useCallback(
    (input: { taskId: string; status: TaskStatus }) => {
      void setStatus(input);
    },
    [setStatus],
  );
  const viewOptions = useMemo(
    () => [
      { value: "list", label: t("tasks.view.list") },
      { value: "board", label: t("tasks.view.board") },
    ],
    [t],
  );

  const handleOpenCreate = useCallback(() => setIsCreating(true), []);
  const handleCloseCreate = useCallback(() => setIsCreating(false), []);

  return (
    <View style={styles.container}>
      <MenuHeader title={t("tasks.screen.title")} />
      <View style={styles.subHeader}>
        <SegmentedControl
          size="sm"
          value={view}
          onValueChange={handleSelectView}
          options={viewOptions}
          testID="tasks-view-picker"
        />
        <Text style={styles.count}>{t("tasks.screen.taskCount", { count: total })}</Text>
        <Button
          variant="ghost"
          size="sm"
          leftIcon={Plus}
          onPress={handleOpenCreate}
          testID="tasks-new"
        >
          {t("tasks.screen.newTask")}
        </Button>
      </View>

      {isLoading && !snapshot ? (
        <View style={styles.centered}>
          <LoadingSpinner size="large" color={styles.spinner.color} />
        </View>
      ) : null}

      {isError && !snapshot ? (
        <View style={styles.centered}>
          <Text style={styles.errorText}>{toErrorMessage(error)}</Text>
          <Button variant="ghost" size="sm" onPress={refetch} testID="tasks-retry">
            {t("common.actions.retry")}
          </Button>
        </View>
      ) : null}

      {snapshot && total === 0 ? (
        <View style={styles.centered}>
          <Text style={styles.message}>{t("tasks.screen.empty")}</Text>
        </View>
      ) : null}

      {view === "board" ? (
        <ScrollView style={styles.scroll}>
          <TaskBoard
            tasks={snapshot?.tasks ?? []}
            labels={snapshot?.labels ?? []}
            projectsById={projectsById}
            onSetStatus={handleSetStatus}
            selectedColumn={boardColumn}
            onSelectColumn={setBoardColumn}
          />
        </ScrollView>
      ) : (
        <ScrollView style={styles.scroll} testID="tasks-list">
          {groups.map((group) => (
            <View key={group.status} style={styles.group}>
              <View style={styles.groupHeader} testID={`tasks-group-${group.status}`}>
                <Text style={styles.groupTitle}>{t(TASK_STATUS_LABEL_KEYS[group.status])}</Text>
                <Text style={styles.groupCount}>{group.tasks.length}</Text>
              </View>
              {group.tasks.map((task) => (
                <TaskRow
                  key={task.id}
                  task={task}
                  project={projectsById.get(task.projectId)}
                  labels={snapshot?.labels ?? []}
                />
              ))}
            </View>
          ))}
        </ScrollView>
      )}

      {isCreating ? (
        <NewTaskSheet
          serverId={serverId}
          projects={snapshot?.projects ?? []}
          onClose={handleCloseCreate}
        />
      ) : null}
    </View>
  );
}

function TaskRow({
  task,
  project,
  labels,
}: {
  task: Task;
  project: TaskProject | undefined;
  labels: readonly TaskLabel[];
}): ReactElement {
  const taskLabels = resolveTaskLabels(task, labels);
  const { visible, hidden } = partitionTaskLabels(taskLabels, ROW_LABEL_CAP);

  return (
    <View style={styles.row} testID={`task-row-${task.id}`}>
      <Text style={styles.rowKey}>{formatTaskKey(project, task)}</Text>
      <Text style={styles.rowTitle} numberOfLines={1}>
        {task.title}
      </Text>
      <View style={styles.rail}>
        {task.agents.length > 0 ? <View style={styles.activeDot} /> : null}
        {visible.map((label) => (
          <View key={label.id} style={styles.chip}>
            <View style={[styles.chipDot, { backgroundColor: label.color }]} />
            <Text style={styles.chipText} numberOfLines={1}>
              {label.name}
            </Text>
          </View>
        ))}
        {hidden.length > 0 ? (
          <View style={styles.chip}>
            <Text style={styles.chipText}>{`+${hidden.length}`}</Text>
          </View>
        ) : null}
        {task.commentCount > 0 ? <Text style={styles.railText}>{task.commentCount}</Text> : null}
      </View>
    </View>
  );
}

/**
 * A task needs a project, and a first-run host has none. Rather than sending the
 * reader somewhere else to make one, the same sheet creates it — a tracker whose
 * empty state is a dead end is a tracker nobody starts using.
 */
function NewTaskSheet({
  serverId,
  projects,
  onClose,
}: {
  serverId: string;
  projects: readonly TaskProject[];
  onClose: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const { createProject, createTask, isBusy } = useTaskMutations(serverId);
  const [title, setTitle] = useState("");
  const [projectName, setProjectName] = useState("");
  const [prefix, setPrefix] = useState("");
  const [submitError, setSubmitError] = useState<string | null>(null);

  const needsProject = projects.length === 0;
  const canSubmit =
    title.trim().length > 0 &&
    (!needsProject || (projectName.trim().length > 0 && prefix.trim().length > 0)) &&
    !isBusy;

  const handleSubmit = useCallback(() => {
    setSubmitError(null);
    void (async () => {
      try {
        // The id comes back from the create rather than from the snapshot: the
        // snapshot has not refetched yet, so reading it here would find nothing
        // and silently drop the task.
        const projectId = needsProject
          ? await createProject({
              name: projectName.trim(),
              prefix: prefix.trim(),
              color: DEFAULT_PROJECT_COLOR,
            })
          : projects[0]?.id;
        if (!projectId) {
          throw new Error(t("tasks.form.noProject"));
        }
        await createTask({ projectId, title: title.trim() });
        onClose();
      } catch (error) {
        setSubmitError(toErrorMessage(error));
      }
    })();
  }, [createProject, createTask, needsProject, onClose, prefix, projectName, projects, t, title]);

  const header = useMemo(() => ({ title: t("tasks.form.title") }), [t]);
  const footer = useMemo(
    () => (
      <Button
        variant="default"
        onPress={handleSubmit}
        disabled={!canSubmit}
        loading={isBusy}
        testID="tasks-form-submit"
      >
        {t("tasks.form.submit")}
      </Button>
    ),
    [canSubmit, handleSubmit, isBusy, t],
  );

  return (
    <AdaptiveModalSheet
      header={header}
      visible
      onClose={onClose}
      footer={footer}
      testID="tasks-form-sheet"
    >
      <View style={styles.form}>
        {needsProject ? (
          <>
            <Text style={styles.formHint}>{t("tasks.form.firstProjectHint")}</Text>
            <Field label={t("tasks.form.projectNameLabel")} testID="tasks-form-project-name">
              <FormTextInput
                value={projectName}
                onChangeText={setProjectName}
                placeholder={t("tasks.form.projectNamePlaceholder")}
                testID="tasks-form-project-name-input"
              />
            </Field>
            <Field
              label={t("tasks.form.prefixLabel")}
              hint={t("tasks.form.prefixHint")}
              testID="tasks-form-prefix"
            >
              <FormTextInput
                value={prefix}
                onChangeText={setPrefix}
                placeholder={t("tasks.form.prefixPlaceholder")}
                testID="tasks-form-prefix-input"
              />
            </Field>
          </>
        ) : null}
        <Field label={t("tasks.form.taskTitleLabel")} testID="tasks-form-title">
          <FormTextInput
            value={title}
            onChangeText={setTitle}
            placeholder={t("tasks.form.taskTitlePlaceholder")}
            testID="tasks-form-title-input"
          />
        </Field>
        {submitError ? <Text style={styles.errorText}>{submitError}</Text> : null}
      </View>
    </AdaptiveModalSheet>
  );
}

export const TASKS_SCREEN_STATUSES = TASK_STATUSES;

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
  count: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  scroll: {
    flex: 1,
    minHeight: 0,
  },
  group: {
    paddingBottom: theme.spacing[2],
  },
  groupHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: { xs: theme.spacing[3], md: theme.spacing[6] },
    paddingVertical: theme.spacing[2],
    backgroundColor: theme.colors.surface1,
  },
  groupTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  groupCount: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: { xs: theme.spacing[3], md: theme.spacing[6] },
    paddingVertical: theme.spacing[2],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  rowKey: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    minWidth: 64,
  },
  rowTitle: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  rail: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    flexShrink: 0,
  },
  // Derived, live, and deliberately beside the stored facts rather than mixed in.
  activeDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: theme.colors.statusSuccess,
  },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    maxWidth: 128,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.full,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 2,
  },
  chipDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  chipText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  railText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  form: {
    gap: theme.spacing[4],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
  },
  formHint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
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
  errorText: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
  spinner: {
    color: theme.colors.foregroundMuted,
  },
}));
