import { useCallback, type ReactElement } from "react";
import { Text, TextInput, View } from "react-native";
import { Filter, Plus, Search, SlidersHorizontal } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { TASK_PRIORITIES, TASK_STATUSES, type TaskLabel } from "@getpaseo/protocol/tasks/types";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { DropdownTrigger } from "@/components/ui/dropdown-trigger";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import type { TaskSort } from "@/tasks/task-views";
import { taskLabelFilterOptions } from "@/tasks/task-views";
import type {
  TaskSurfacePreferences,
  TaskSurfaceView,
} from "@/stores/task-surface-preferences-store";
import { TASK_PRIORITY_LABEL_KEYS, TASK_STATUS_LABEL_KEYS } from "./task-board-parts";
import { useTranslation } from "react-i18next";
import type { Theme } from "@/styles/theme";

const ThemedSearch = withUnistyles(Search);
const mutedIcon = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

function toggleValue<T>(values: readonly T[], value: T): T[] {
  return values.includes(value) ? values.filter((entry) => entry !== value) : [...values, value];
}

export function TaskSurfaceToolbar({
  preferences,
  viewOptions,
  labels,
  visibleCount,
  totalCount,
  onPatch,
  onClearFilters,
  onCreateTask,
  reorderDisabled,
}: {
  preferences: TaskSurfacePreferences;
  viewOptions: SegmentedControlOption<TaskSurfaceView>[];
  labels: readonly TaskLabel[];
  visibleCount: number;
  totalCount: number;
  onPatch: (patch: Partial<TaskSurfacePreferences>) => void;
  onClearFilters: () => void;
  onCreateTask: () => void;
  reorderDisabled: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const labelOptions = taskLabelFilterOptions(labels);
  const activeFilterCount =
    preferences.statuses.length + preferences.priorities.length + preferences.labelNames.length;
  const hasFilters = activeFilterCount > 0 || preferences.query.trim().length > 0;
  const handleView = useCallback((view: TaskSurfaceView) => onPatch({ view }), [onPatch]);
  const handleQuery = useCallback((query: string) => onPatch({ query }), [onPatch]);
  const handleSort = useCallback((sort: TaskSort) => onPatch({ sort }), [onPatch]);

  return (
    <View style={styles.toolbar} testID="task-surface-toolbar">
      <SegmentedControl
        size="xs"
        value={preferences.view}
        onValueChange={handleView}
        options={viewOptions}
        testID="task-view-picker"
      />
      <View style={styles.searchBox}>
        <ThemedSearch size={14} uniProps={mutedIcon} />
        <TextInput
          value={preferences.query}
          onChangeText={handleQuery}
          placeholder="Search tasks"
          placeholderTextColor={styles.searchPlaceholder.color}
          style={styles.searchInput}
          testID="task-search"
        />
      </View>
      <FacetMenu
        label="Status"
        count={preferences.statuses.length}
        items={TASK_STATUSES.map((status) => ({
          key: status,
          label: t(TASK_STATUS_LABEL_KEYS[status]),
          selected: preferences.statuses.includes(status),
          onSelect: () => onPatch({ statuses: toggleValue(preferences.statuses, status) }),
        }))}
      />
      <FacetMenu
        label="Priority"
        count={preferences.priorities.length}
        items={TASK_PRIORITIES.map((priority) => ({
          key: priority,
          label:
            priority === "none"
              ? t("tasks.detail.priorityNone")
              : t(TASK_PRIORITY_LABEL_KEYS[priority]),
          selected: preferences.priorities.includes(priority),
          onSelect: () => onPatch({ priorities: toggleValue(preferences.priorities, priority) }),
        }))}
      />
      {labelOptions.length > 0 ? (
        <FacetMenu
          label="Label"
          count={preferences.labelNames.length}
          items={labelOptions.map((option) => ({
            key: option.name,
            label: option.name,
            selected: preferences.labelNames.includes(option.name),
            onSelect: () =>
              onPatch({ labelNames: toggleValue(preferences.labelNames, option.name) }),
          }))}
        />
      ) : null}
      <SortMenu sort={preferences.sort} onSelect={handleSort} />
      {hasFilters ? (
        <Button variant="ghost" size="xs" onPress={onClearFilters} testID="task-filters-clear">
          Clear
        </Button>
      ) : null}
      <Text style={styles.count}>
        {visibleCount === totalCount ? totalCount : `${visibleCount}/${totalCount}`}
      </Text>
      {preferences.view === "kanban" && reorderDisabled ? (
        <Text style={styles.hint}>Clear filters or use manual order to drag</Text>
      ) : null}
      <Button
        variant="outline"
        size="xs"
        leftIcon={Plus}
        onPress={onCreateTask}
        testID="task-list-add"
      >
        {t("tasks.screen.newTask")}
      </Button>
    </View>
  );
}

function FacetMenu({
  label,
  count,
  items,
}: {
  label: string;
  count: number;
  items: Array<{ key: string; label: string; selected: boolean; onSelect: () => void }>;
}): ReactElement {
  return (
    <DropdownMenu>
      <DropdownTrigger style={styles.trigger} accessibilityLabel={`Filter by ${label}`}>
        <Filter size={13} color={styles.triggerIcon.color} />
        <Text style={styles.triggerText}>{count > 0 ? `${label} ${count}` : label}</Text>
      </DropdownTrigger>
      <DropdownMenuContent align="start">
        {items.map((item) => (
          <DropdownMenuItem
            key={item.key}
            selected={item.selected}
            showSelectedCheck
            closeOnSelect={false}
            onSelect={item.onSelect}
          >
            {item.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function SortMenu({ sort, onSelect }: { sort: TaskSort; onSelect: (sort: TaskSort) => void }) {
  const options: Array<{ value: TaskSort; label: string }> = [
    { value: "manual", label: "Manual order" },
    { value: "priority", label: "Priority" },
    { value: "due", label: "Due date" },
  ];
  return (
    <DropdownMenu>
      <DropdownTrigger style={styles.trigger} accessibilityLabel="Sort tasks">
        <SlidersHorizontal size={13} color={styles.triggerIcon.color} />
        <Text style={styles.triggerText}>Sort</Text>
      </DropdownTrigger>
      <DropdownMenuContent align="start">
        {options.map((option) => (
          <SortOption
            key={option.value}
            option={option}
            selected={sort === option.value}
            onSelect={onSelect}
          />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function SortOption({
  option,
  selected,
  onSelect,
}: {
  option: { value: TaskSort; label: string };
  selected: boolean;
  onSelect: (sort: TaskSort) => void;
}): ReactElement {
  const handleSelect = useCallback(() => onSelect(option.value), [onSelect, option.value]);
  return (
    <DropdownMenuItem selected={selected} showSelectedCheck onSelect={handleSelect}>
      {option.label}
    </DropdownMenuItem>
  );
}

const styles = StyleSheet.create((theme) => ({
  toolbar: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[1.5],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  searchBox: {
    minWidth: 150,
    maxWidth: 280,
    flexGrow: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    height: 28,
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface1,
  },
  searchInput: {
    minWidth: 0,
    flex: 1,
    padding: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.xs,
  },
  searchPlaceholder: { color: theme.colors.foregroundMuted },
  trigger: {
    minHeight: 28,
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
  },
  triggerText: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.xs },
  triggerIcon: { color: theme.colors.foregroundMuted },
  count: {
    marginLeft: "auto",
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  hint: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.xs },
}));
