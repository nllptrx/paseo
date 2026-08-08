import type { TaskProject, TaskStatus } from "@getpaseo/protocol/tasks/types";

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

export interface NewTaskFormSnapshot {
  serverId: string;
  /** The tracker project the task lands in, or null when the capture must
   * create it. Captured at open time: the sheet mounts fresh per open. */
  project: TaskProject | null;
  paseoProjectId: string | null;
  suggestedProjectName: string;
  initialStatus: TaskStatus;
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
    title: "",
    projectName: needsProject ? snapshot.suggestedProjectName : (snapshot.project?.name ?? ""),
    prefix: needsProject
      ? suggestTaskProjectPrefix(snapshot.suggestedProjectName)
      : (snapshot.project?.prefix ?? ""),
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
    setSubmitting(value) {
      publish({ ...state, isSubmitting: value });
    },
    setSubmitError(value) {
      publish({ ...state, submitError: value, isSubmitting: false });
    },
  };
}
