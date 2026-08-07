import { useCallback, useMemo, type ReactElement } from "react";
import { ScrollView, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { TASK_STATUSES } from "@getpaseo/protocol/tasks/types";
import { useIsCompactFormFactor } from "@/constants/layout";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { visibleBoardStatuses } from "@/tasks/task-views";
import {
  TASK_STATUS_LABEL_KEYS,
  TaskColumn,
  groupBoardTasks,
  useMoveToStatusEnd,
  type TaskBoardMove,
  type TaskBoardProps,
} from "./task-board-parts";

export {
  TASK_STATUS_LABEL_KEYS,
  type TaskBoardMove,
  type TaskBoardProps,
} from "./task-board-parts";

/**
 * The kanban board: one column per stored status. Wide layouts get every column
 * at once; a compact one picks one at a time, because five columns on a phone
 * are five columns you cannot read. Dragging lives in the web file — this one
 * moves through the card menu.
 */
export function TaskBoard({
  serverId,
  tasks,
  labels,
  projectsById,
  onMoveTask,
  onCreateTask,
  onOpenAgent,
  onReviewTask,
  onDeleteTask,
  onCreatePlanForTask,
  selectedColumn,
  onSelectColumn,
}: TaskBoardProps): ReactElement {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const statuses = useMemo(() => visibleBoardStatuses(tasks), [tasks]);
  const byStatus = useMemo(() => groupBoardTasks(statuses, tasks), [statuses, tasks]);
  const handleMoveToStatus = useMoveToStatusEnd(byStatus, onMoveTask);

  const handleSelectColumn = useCallback(
    (value: string) => {
      const status = TASK_STATUSES.find((entry) => entry === value);
      if (status) {
        onSelectColumn(status);
      }
    },
    [onSelectColumn],
  );

  const options = useMemo(
    () =>
      statuses.map((status) => ({
        value: status,
        label: t(TASK_STATUS_LABEL_KEYS[status]),
      })),
    [statuses, t],
  );

  if (isCompact) {
    const active = statuses.includes(selectedColumn) ? selectedColumn : statuses[0];
    return (
      <View style={styles.compact} testID="task-board">
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <SegmentedControl
            size="sm"
            value={active ?? "backlog"}
            onValueChange={handleSelectColumn}
            options={options}
            testID="task-board-column-picker"
          />
        </ScrollView>
        {active ? (
          <TaskColumn
            serverId={serverId}
            status={active}
            tasks={byStatus.get(active) ?? []}
            labels={labels}
            projectsById={projectsById}
            onMoveToStatus={handleMoveToStatus}
            onCreateTask={onCreateTask}
            onOpenAgent={onOpenAgent}
            onReviewTask={onReviewTask}
            onDeleteTask={onDeleteTask}
            onCreatePlanForTask={onCreatePlanForTask}
          />
        ) : null}
      </View>
    );
  }

  return (
    <ScrollView horizontal contentContainerStyle={styles.wideRow} testID="task-board">
      {statuses.map((status) => (
        <TaskColumn
          key={status}
          serverId={serverId}
          status={status}
          tasks={byStatus.get(status) ?? []}
          labels={labels}
          projectsById={projectsById}
          onMoveToStatus={handleMoveToStatus}
          onCreateTask={onCreateTask}
          onOpenAgent={onOpenAgent}
          onReviewTask={onReviewTask}
          onDeleteTask={onDeleteTask}
          onCreatePlanForTask={onCreatePlanForTask}
        />
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create((theme) => ({
  compact: {
    gap: theme.spacing[3],
    padding: theme.spacing[3],
  },
  wideRow: {
    flexDirection: "row",
    gap: theme.spacing[3],
    padding: theme.spacing[3],
    alignItems: "flex-start",
  },
}));
