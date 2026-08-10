import {
  TASK_STATUSES,
  type Task,
  type TaskLabel,
  type TaskPriority,
  type TaskProject,
  type TaskSnapshot,
  type TaskStatus,
} from "@getpaseo/protocol/tasks/types";

export interface ProjectBoardSelection {
  /** Tracker projects linked to the Paseo project, in snapshot order. */
  projects: TaskProject[];
  /** Their tasks, manual-sorted, ready for the board. */
  tasks: Task[];
  /** Labels scoped to those projects. */
  labels: TaskLabel[];
}

/**
 * One Paseo project's slice of the tracker. The kanban board is per project,
 * so it shows the tasks of the tracker projects linked to it — nothing else.
 */
export function selectProjectBoard(
  snapshot: TaskSnapshot | null,
  paseoProjectId: string,
): ProjectBoardSelection {
  if (!snapshot) {
    return { projects: [], tasks: [], labels: [] };
  }
  const projects = snapshot.projects.filter((project) => project.paseoProjectId === paseoProjectId);
  const projectIds = new Set(projects.map((project) => project.id));
  return {
    projects,
    tasks: sortTasks(
      snapshot.tasks.filter((task) => projectIds.has(task.projectId)),
      "manual",
    ),
    labels: snapshot.labels.filter((label) => projectIds.has(label.projectId)),
  };
}

/** One tracker project's board, addressed directly. The board screen routes by
 * tracker project, so it does not go through the Paseo project at all. */
export function selectTrackerProjectBoard(
  snapshot: TaskSnapshot | null,
  trackerProjectId: string,
): ProjectBoardSelection {
  if (!snapshot) {
    return { projects: [], tasks: [], labels: [] };
  }
  const project = snapshot.projects.find((entry) => entry.id === trackerProjectId);
  if (!project) {
    return { projects: [], tasks: [], labels: [] };
  }
  return {
    projects: [project],
    tasks: sortTasks(
      snapshot.tasks.filter((task) => task.projectId === project.id),
      "manual",
    ),
    labels: snapshot.labels.filter((label) => label.projectId === project.id),
  };
}

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

/** The overview is a way in, not the board: past this many cards the answer is
 * to open the board, which is one press away. */
export const OVERVIEW_RENDER_CAP = 20;

const OVERVIEW_STATUS_ORDER: readonly TaskStatus[] = [
  "in_progress",
  "in_review",
  "todo",
  "backlog",
  "done",
  "canceled",
];

export interface TaskOverviewSelection {
  tasks: Task[];
  totalCount: number;
  hiddenCount: number;
}

/**
 * What a project's column shows at a glance: work in flight first, then what is
 * queued, then what is finished — the order someone scanning several projects
 * reads in. Capped, with the remainder counted rather than dropped silently.
 */
export function selectOverviewTasks(
  tasks: readonly Task[],
  cap: number = OVERVIEW_RENDER_CAP,
): TaskOverviewSelection {
  const ranked = [...tasks].sort((left, right) => {
    const byStatus =
      OVERVIEW_STATUS_ORDER.indexOf(left.status) - OVERVIEW_STATUS_ORDER.indexOf(right.status);
    return byStatus !== 0 ? byStatus : left.position - right.position;
  });
  const visible = ranked.slice(0, cap);
  return { tasks: visible, totalCount: tasks.length, hiddenCount: tasks.length - visible.length };
}

export interface TaskDependencyEdge {
  taskId: string;
  dependsOnTaskId: string;
}

export interface TaskRelationshipSummary {
  subtaskCount: number;
  blockerCount: number;
  /** Direct children by stored status. An aggregate holds no work of its own, so
   * this is the only thing on its card that says how the work is going. */
  childRunningCount: number;
  childReviewCount: number;
  childDoneCount: number;
}

export function buildTaskRelationshipSummaries(input: {
  tasks: readonly Task[];
  dependencies: readonly TaskDependencyEdge[];
}): ReadonlyMap<string, TaskRelationshipSummary> {
  const summaries = new Map<string, TaskRelationshipSummary>();
  const tasksById = new Map(input.tasks.map((task) => [task.id, task]));
  for (const task of input.tasks) {
    summaries.set(task.id, {
      subtaskCount: 0,
      blockerCount: 0,
      childRunningCount: 0,
      childReviewCount: 0,
      childDoneCount: 0,
    });
  }
  for (const task of input.tasks) {
    if (!task.parentTaskId) continue;
    const parent = summaries.get(task.parentTaskId);
    if (!parent) continue;
    parent.subtaskCount += 1;
    if (task.status === "in_progress") parent.childRunningCount += 1;
    if (task.status === "in_review") parent.childReviewCount += 1;
    if (task.status === "done") parent.childDoneCount += 1;
  }
  for (const edge of input.dependencies) {
    const blocker = tasksById.get(edge.dependsOnTaskId);
    const summary = summaries.get(edge.taskId);
    if (!blocker || !summary || blocker.status === "done" || blocker.status === "canceled") {
      continue;
    }
    summary.blockerCount += 1;
  }
  return summaries;
}

/**
 * The tasks a card is still waiting on. A blocker that is done or canceled
 * stops blocking — canceled work is never going to arrive, and holding the
 * dependent forever would strand it.
 */
export function selectBlockers(input: {
  taskId: string;
  tasks: readonly Task[];
  dependencies: readonly TaskDependencyEdge[];
}): Task[] {
  const byId = new Map(input.tasks.map((task) => [task.id, task]));
  return input.dependencies
    .filter((edge) => edge.taskId === input.taskId)
    .flatMap((edge) => {
      const blocker = byId.get(edge.dependsOnTaskId);
      if (!blocker || blocker.status === "done" || blocker.status === "canceled") {
        return [];
      }
      return [blocker];
    });
}

/**
 * What an aggregate's card says about its children, in the order someone scans
 * for: what is moving, what is waiting on them, what is finished. Empty when the
 * task has no children or none of them has reached one of those statuses.
 */
export function formatAggregateChildStates(
  summary: TaskRelationshipSummary | undefined,
): string | null {
  if (!summary || summary.subtaskCount === 0) {
    return null;
  }
  const parts: string[] = [];
  if (summary.childRunningCount > 0) parts.push(`${summary.childRunningCount} running`);
  if (summary.childReviewCount > 0) parts.push(`${summary.childReviewCount} ready to review`);
  if (summary.childDoneCount > 0) parts.push(`${summary.childDoneCount} done`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

export interface TaskBoardRow {
  task: Task;
  depth: number;
  /**
   * The row sits in its parent's column rather than the one its own status
   * names. Such a row is not a drop slot: its position would be read against a
   * column it is not stored in.
   */
  collapsed: boolean;
}

export interface TaskColumnProjection {
  rows: TaskBoardRow[];
  /**
   * How many tasks are stored in this status, whatever column the projection
   * draws them in. The column badge counts these: the stored statuses are the
   * only column truth, so a child collapsed under a parent elsewhere must not
   * inflate that column nor vanish from its own.
   */
  storedCount: number;
}

/**
 * The cards each column renders. Columns stay the stored statuses; what the
 * projection decides is where a subtask is drawn.
 *
 * Collapsed (the default), an aggregate keeps its children under its own card
 * whatever column their status would put them in — the parent is the unit of
 * work, and a chain of five phases scattered across five columns reads as five
 * unrelated cards. Expanded, every task is drawn in its own status column and
 * only nests where its parent is in the same one.
 */
export function projectBoardColumns(input: {
  statuses: readonly TaskStatus[];
  tasks: readonly Task[];
  expandSubtasks: boolean;
}): Map<TaskStatus, TaskColumnProjection> {
  const columns = new Map<TaskStatus, TaskColumnProjection>(
    input.statuses.map((status) => [status, { rows: [], storedCount: 0 }]),
  );
  for (const task of input.tasks) {
    const column = columns.get(task.status);
    if (column) column.storedCount += 1;
  }
  const bucket = (status: TaskStatus): TaskBoardRow[] | undefined => columns.get(status)?.rows;

  if (input.expandSubtasks) {
    for (const status of input.statuses) {
      const inColumn = input.tasks.filter((task) => task.status === status);
      const rows = bucket(status);
      for (const row of groupSubtasksUnderParents(inColumn)) {
        rows?.push({ task: row.task, depth: row.depth, collapsed: false });
      }
    }
    return columns;
  }

  const present = new Set(input.tasks.map((task) => task.id));
  const childrenByParent = new Map<string, Task[]>();
  const roots: Task[] = [];
  for (const task of input.tasks) {
    if (task.parentTaskId && present.has(task.parentTaskId)) {
      const siblings = childrenByParent.get(task.parentTaskId) ?? [];
      siblings.push(task);
      childrenByParent.set(task.parentTaskId, siblings);
      continue;
    }
    roots.push(task);
  }

  const drawn = new Set<string>();
  const visit = (task: Task, status: TaskStatus, depth: number): void => {
    if (drawn.has(task.id)) {
      return;
    }
    drawn.add(task.id);
    bucket(status)?.push({ task, depth, collapsed: task.status !== status });
    for (const child of childrenByParent.get(task.id) ?? []) {
      visit(child, status, depth + 1);
    }
  };
  for (const root of roots) {
    visit(root, root.status, 0);
  }
  // Parent links can form a cycle, and every card in one is somebody's child and
  // so never a root. Drawing them in their own column loses the nesting; not
  // drawing them loses the work.
  for (const task of input.tasks) {
    visit(task, task.status, 0);
  }
  return columns;
}

/** Subtasks render under their parent, so a column orders parents and hands
 * each its children rather than scattering them by position. */
export function groupSubtasksUnderParents(tasks: readonly Task[]): Array<{
  task: Task;
  depth: number;
}> {
  const childrenByParent = new Map<string, Task[]>();
  const roots: Task[] = [];
  const present = new Set(tasks.map((task) => task.id));
  for (const task of tasks) {
    if (task.parentTaskId && present.has(task.parentTaskId)) {
      const bucket = childrenByParent.get(task.parentTaskId) ?? [];
      bucket.push(task);
      childrenByParent.set(task.parentTaskId, bucket);
      continue;
    }
    roots.push(task);
  }

  const rows: Array<{ task: Task; depth: number }> = [];
  const rendered = new Set<string>();
  const visit = (task: Task, depth: number): void => {
    if (rendered.has(task.id)) {
      return;
    }
    rendered.add(task.id);
    rows.push({ task, depth });
    for (const child of childrenByParent.get(task.id) ?? []) {
      visit(child, depth + 1);
    }
  };
  for (const root of roots) {
    visit(root, 0);
  }
  // Parent links can form a cycle, and every card in one would be a child of
  // something and so never a root. Showing them flat is wrong-looking; not
  // showing them at all loses work.
  for (const task of tasks) {
    if (!rendered.has(task.id)) {
      rendered.add(task.id);
      rows.push({ task, depth: 0 });
    }
  }
  return rows;
}
