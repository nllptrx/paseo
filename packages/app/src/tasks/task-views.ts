import {
  TASK_STATUSES,
  type Task,
  type TaskLabel,
  type TaskPriority,
  type TaskProject,
  type TaskStatus,
} from "@getpaseo/protocol/tasks/types";

/**
 * Columns the board always shows. `canceled` is not one of them: a board is
 * where work is going, and a permanently visible column of abandoned work is
 * dead width. It appears only once something is in it.
 */
export const BOARD_STATUSES: readonly TaskStatus[] = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "done",
];

export function visibleBoardStatuses(tasks: readonly Task[]): TaskStatus[] {
  const hasCanceled = tasks.some((task) => task.status === "canceled");
  return hasCanceled ? [...BOARD_STATUSES, "canceled"] : [...BOARD_STATUSES];
}

export interface TaskStatusGroup {
  status: TaskStatus;
  tasks: Task[];
}

/**
 * Buckets into canonical status order and drops the empty groups — a list of
 * headings with nothing under them reads as a broken filter.
 *
 * Order inside a group is the order it was given, so the caller decides sorting
 * by pre-sorting.
 */
export function groupTasksByStatus(tasks: readonly Task[]): TaskStatusGroup[] {
  const byStatus = new Map<TaskStatus, Task[]>();
  for (const task of tasks) {
    const bucket = byStatus.get(task.status);
    if (bucket) {
      bucket.push(task);
    } else {
      byStatus.set(task.status, [task]);
    }
  }
  return TASK_STATUSES.flatMap((status) => {
    const bucket = byStatus.get(status);
    return bucket ? [{ status, tasks: bucket }] : [];
  });
}

/** `PSE-42`. Short enough to say out loud and paste into a commit message. */
export function formatTaskKey(
  project: Pick<TaskProject, "prefix"> | undefined,
  task: Pick<Task, "number">,
): string {
  return `${project?.prefix ?? "?"}-${task.number}`;
}

export interface TaskLabelFilterOption {
  name: string;
  color: string;
  /** Every label sharing this name — one per project when the view spans several. */
  labelIds: string[];
}

/**
 * Collapses labels by name, so selecting "bug" on an all-projects view matches
 * every project's own "bug" instead of asking which one you meant.
 */
export function taskLabelFilterOptions(labels: readonly TaskLabel[]): TaskLabelFilterOption[] {
  const byName = new Map<string, TaskLabelFilterOption>();
  for (const label of labels) {
    const existing = byName.get(label.name);
    if (existing) {
      existing.labelIds.push(label.id);
      continue;
    }
    byName.set(label.name, { name: label.name, color: label.color, labelIds: [label.id] });
  }
  return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
}

export interface TaskFilters {
  projectId?: string | null;
  statuses?: readonly TaskStatus[];
  priorities?: readonly TaskPriority[];
  labelNames?: readonly string[];
}

/** An unset facet does not narrow anything; an empty selection is the same as unset. */
export function filterTasks(input: {
  tasks: readonly Task[];
  labels: readonly TaskLabel[];
  filters: TaskFilters;
}): Task[] {
  const { tasks, labels, filters } = input;
  const labelIds =
    filters.labelNames && filters.labelNames.length > 0
      ? new Set(
          taskLabelFilterOptions(labels)
            .filter((option) => filters.labelNames?.includes(option.name))
            .flatMap((option) => option.labelIds),
        )
      : null;

  return tasks.filter((task) => {
    if (filters.projectId && task.projectId !== filters.projectId) {
      return false;
    }
    if (
      filters.statuses &&
      filters.statuses.length > 0 &&
      !filters.statuses.includes(task.status)
    ) {
      return false;
    }
    if (
      filters.priorities &&
      filters.priorities.length > 0 &&
      !filters.priorities.includes(task.priority)
    ) {
      return false;
    }
    if (labelIds && !task.labelIds.some((id) => labelIds.has(id))) {
      return false;
    }
    return true;
  });
}

export type TaskSort = "manual" | "priority" | "due";

const PRIORITY_RANK: Record<TaskPriority, number> = {
  urgent: 0,
  high: 1,
  medium: 2,
  low: 3,
  none: 4,
};

/**
 * `manual` is the order you dragged things into, which is why it is the default:
 * every other sort throws that away. A task with no due date sorts after every
 * task that has one — no date is not an early date.
 */
export function sortTasks(tasks: readonly Task[], sort: TaskSort): Task[] {
  const sorted = [...tasks];
  if (sort === "manual") {
    sorted.sort((left, right) => left.position - right.position || left.id.localeCompare(right.id));
    return sorted;
  }
  if (sort === "priority") {
    sorted.sort(
      (left, right) =>
        PRIORITY_RANK[left.priority] - PRIORITY_RANK[right.priority] ||
        left.position - right.position,
    );
    return sorted;
  }
  sorted.sort((left, right) => {
    if (left.dueDate === right.dueDate) {
      return left.position - right.position;
    }
    if (left.dueDate === null) {
      return 1;
    }
    if (right.dueDate === null) {
      return -1;
    }
    return left.dueDate.localeCompare(right.dueDate);
  });
  return sorted;
}

/**
 * Row metadata has to stay a bounded width or a task with nine labels pushes the
 * title off the row. The ones that do not fit collapse into a count that names
 * them on hover.
 */
export function partitionTaskLabels(
  labels: readonly TaskLabel[],
  maxVisible: number,
): { visible: TaskLabel[]; hidden: TaskLabel[] } {
  if (labels.length <= maxVisible) {
    return { visible: [...labels], hidden: [] };
  }
  return { visible: labels.slice(0, maxVisible), hidden: labels.slice(maxVisible) };
}

export function resolveTaskLabels(
  task: Pick<Task, "labelIds">,
  labels: readonly TaskLabel[],
): TaskLabel[] {
  const byId = new Map(labels.map((label) => [label.id, label]));
  return task.labelIds.flatMap((id) => {
    const label = byId.get(id);
    return label ? [label] : [];
  });
}

/**
 * The neighbours a card landed between, which is what the daemon needs to pick a
 * position. `index` is the slot in the destination column the card is going to,
 * counted with the card already removed from wherever it came from.
 */
export function resolveTaskDropNeighbours(
  columnTasks: readonly Task[],
  index: number,
): { beforePosition: number | null; afterPosition: number | null } {
  const clamped = Math.max(0, Math.min(index, columnTasks.length));
  return {
    beforePosition: clamped === 0 ? null : (columnTasks[clamped - 1]?.position ?? null),
    afterPosition: clamped >= columnTasks.length ? null : (columnTasks[clamped]?.position ?? null),
  };
}
