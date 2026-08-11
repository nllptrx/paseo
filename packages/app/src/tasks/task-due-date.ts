export type TaskDueDatePreset = "today" | "tomorrow" | "next-week";

export interface TaskDueDateFormState {
  dueDate: string;
  validationError: string | null;
  submitError: string | null;
  canSubmit: boolean;
}

export interface TaskDueDateFormModel {
  getState: () => TaskDueDateFormState;
  subscribe: (listener: () => void) => () => void;
  close: () => void;
  setDueDate: (value: string) => void;
  setSubmitError: (value: string | null) => void;
}

const INVALID_DUE_DATE_MESSAGE = "Enter a valid date as YYYY-MM-DD.";

export function formatLocalCalendarDate(date: Date): string {
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function resolveTaskDueDatePreset(
  preset: TaskDueDatePreset,
  now: Date = new Date(),
): string {
  const date = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (preset === "tomorrow") {
    date.setDate(date.getDate() + 1);
  } else if (preset === "next-week") {
    date.setDate(date.getDate() + 7);
  }
  return formatLocalCalendarDate(date);
}

export function isValidTaskDueDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;

  const daysInMonth = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= daysInMonth[month - 1];
}

export function openTaskDueDateForm(
  currentDueDate: string | null,
  now: Date = new Date(),
): TaskDueDateFormModel {
  const initialDueDate = currentDueDate ?? formatLocalCalendarDate(now);
  let state = buildState(initialDueDate, currentDueDate, null);
  let closed = false;
  const listeners = new Set<() => void>();

  const publish = (dueDate: string, submitError: string | null) => {
    if (closed) return;
    state = buildState(dueDate, currentDueDate, submitError);
    for (const listener of listeners) listener();
  };

  return {
    getState: () => state,
    subscribe: (listener) => {
      if (closed) return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close: () => {
      closed = true;
      listeners.clear();
    },
    setDueDate: (value) => publish(value, null),
    setSubmitError: (value) => publish(state.dueDate, value),
  };
}

function buildState(
  dueDate: string,
  currentDueDate: string | null,
  submitError: string | null,
): TaskDueDateFormState {
  const validationError = isValidTaskDueDate(dueDate) ? null : INVALID_DUE_DATE_MESSAGE;
  return {
    dueDate,
    validationError,
    submitError,
    canSubmit: validationError === null && dueDate !== currentDueDate,
  };
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}
