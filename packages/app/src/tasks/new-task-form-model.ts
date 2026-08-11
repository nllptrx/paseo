import type { TaskPriority, TaskProject, TaskStatus } from "@getpaseo/protocol/tasks/types";

/** The tracker stores prefixes uppercase and at most this long, so the form
 * cannot let anything else through: past here the failure is a constraint
 * violation with nothing to show the person who typed it. */
const PREFIX_MAX_LENGTH = 8;
const PREFIX_SUGGESTION_LENGTH = 3;

export function normalizeTaskProjectPrefix(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9]/g, "")
    .toUpperCase()
    .slice(0, PREFIX_MAX_LENGTH);
}

/** `Paseo Mobile` → `PAS`: enough to read as a key, always editable before submit. */
export function suggestTaskProjectPrefix(name: string): string {
  const letters = name.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
  return letters.slice(0, PREFIX_SUGGESTION_LENGTH);
}

/** Pick a host-unique key for zero-input board creation. The capture form can
 * ask a person to resolve a collision; opening a project from the global
 * directory cannot. */
export function suggestAvailableTaskProjectPrefix(
  name: string,
  projects: readonly Pick<TaskProject, "prefix">[],
): string {
  const base = suggestTaskProjectPrefix(name) || "TSK";
  const used = new Set(projects.map((project) => project.prefix.toUpperCase()));
  if (!used.has(base)) return base;
  for (let suffix = 2; suffix < 1_000_000; suffix += 1) {
    const suffixText = String(suffix);
    const candidate = `${base.slice(0, PREFIX_MAX_LENGTH - suffixText.length)}${suffixText}`;
    if (!used.has(candidate)) return candidate;
  }
  throw new Error("No task project prefix is available");
}

export interface NewTaskFormSnapshot {
  serverId: string;
  /** The tracker project the task lands in, or null when the capture must
   * create it. Captured at open time: the sheet mounts fresh per open. */
  project: TaskProject | null;
  paseoProjectId: string | null;
  suggestedProjectName: string;
  initialStatus: TaskStatus;
  initialTitle?: string;
}

export interface NewTaskFormState {
  serverId: string;
  projectId: string | null;
  paseoProjectId: string | null;
  initialStatus: TaskStatus;
  needsProject: boolean;
  title: string;
  projectName: string;
  prefix: string;
  status: TaskStatus;
  priority: TaskPriority;
  dueDate: string | null;
  labelIds: readonly string[];
  description: string;
  isSubmitting: boolean;
  submitError: string | null;
  canSubmit: boolean;
}

export interface NewTaskFormModel {
  getState: () => NewTaskFormState;
  subscribe: (listener: () => void) => () => void;
  close: () => void;
  setTitle: (value: string) => void;
  setProjectName: (value: string) => void;
  setPrefix: (value: string) => void;
  setStatus: (value: TaskStatus) => void;
  setPriority: (value: TaskPriority) => void;
  setDueDate: (value: string | null) => void;
  setLabelIds: (value: readonly string[]) => void;
  setDescription: (value: string) => void;
  setSubmitting: (value: boolean) => void;
  setSubmitError: (value: string | null) => void;
}

function resolveCanSubmit(state: NewTaskFormState): boolean {
  if (state.isSubmitting) {
    return false;
  }
  if (state.title.trim().length === 0) {
    return false;
  }
  if (state.needsProject) {
    return (
      state.projectName.trim().length > 0 &&
      state.prefix.length > 0 &&
      state.prefix.length <= PREFIX_MAX_LENGTH
    );
  }
  return true;
}

export function openNewTaskForm(snapshot: NewTaskFormSnapshot): NewTaskFormModel {
  const listeners = new Set<() => void>();
  let closed = false;

  const needsProject = snapshot.project === null;
  let state: NewTaskFormState = {
    serverId: snapshot.serverId,
    projectId: snapshot.project?.id ?? null,
    paseoProjectId: snapshot.paseoProjectId,
    initialStatus: snapshot.initialStatus,
    needsProject,
    title: snapshot.initialTitle ?? "",
    projectName: needsProject ? snapshot.suggestedProjectName : (snapshot.project?.name ?? ""),
    prefix: needsProject
      ? suggestTaskProjectPrefix(snapshot.suggestedProjectName)
      : (snapshot.project?.prefix ?? ""),
    status: snapshot.initialStatus,
    priority: "none",
    dueDate: null,
    labelIds: [],
    description: "",
    isSubmitting: false,
    submitError: null,
    canSubmit: false,
  };
  state = { ...state, canSubmit: resolveCanSubmit(state) };

  function publish(nextState: NewTaskFormState): void {
    if (closed) {
      return;
    }
    state = { ...nextState, canSubmit: resolveCanSubmit(nextState) };
    for (const listener of listeners) {
      listener();
    }
  }

  return {
    getState: () => state,
    subscribe(listener) {
      if (closed) {
        return () => {};
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close() {
      closed = true;
      listeners.clear();
    },
    setTitle(value) {
      publish({ ...state, title: value, submitError: null });
    },
    setProjectName(value) {
      publish({ ...state, projectName: value, submitError: null });
    },
    setPrefix(value) {
      publish({ ...state, prefix: normalizeTaskProjectPrefix(value), submitError: null });
    },
    setStatus(value) {
      publish({ ...state, status: value, submitError: null });
    },
    setPriority(value) {
      publish({ ...state, priority: value, submitError: null });
    },
    setDueDate(value) {
      publish({ ...state, dueDate: value, submitError: null });
    },
    setLabelIds(value) {
      publish({ ...state, labelIds: value, submitError: null });
    },
    setDescription(value) {
      publish({ ...state, description: value, submitError: null });
    },
    setSubmitting(value) {
      publish({ ...state, isSubmitting: value });
    },
    setSubmitError(value) {
      publish({ ...state, submitError: value, isSubmitting: false });
    },
  };
}
