import { describe, expect, it } from "vitest";
import { isValidTaskDueDate, openTaskDueDateForm, resolveTaskDueDatePreset } from "./task-due-date";

describe("task due dates", () => {
  it("resolves presets as local calendar days across month and year boundaries", () => {
    const now = new Date(2028, 11, 31, 23, 45);

    expect(resolveTaskDueDatePreset("today", now)).toBe("2028-12-31");
    expect(resolveTaskDueDatePreset("tomorrow", now)).toBe("2029-01-01");
    expect(resolveTaskDueDatePreset("next-week", now)).toBe("2029-01-07");
  });

  it("accepts real ISO calendar dates and rejects rollovers", () => {
    expect(isValidTaskDueDate("2028-02-29")).toBe(true);
    expect(isValidTaskDueDate("2027-02-29")).toBe(false);
    expect(isValidTaskDueDate("2028-04-31")).toBe(false);
    expect(isValidTaskDueDate("04/30/2028")).toBe(false);
  });

  it("opens fresh, validates edits, and keeps submission errors until the next edit", () => {
    const model = openTaskDueDateForm(null, new Date(2030, 4, 6));
    expect(model.getState()).toEqual({
      dueDate: "2030-05-06",
      validationError: null,
      submitError: null,
      canSubmit: true,
    });

    model.setDueDate("2030-02-30");
    expect(model.getState()).toEqual({
      dueDate: "2030-02-30",
      validationError: "Enter a valid date as YYYY-MM-DD.",
      submitError: null,
      canSubmit: false,
    });

    model.setDueDate("2030-05-17");
    model.setSubmitError("Host disconnected");
    expect(model.getState()).toEqual({
      dueDate: "2030-05-17",
      validationError: null,
      submitError: "Host disconnected",
      canSubmit: true,
    });

    model.setDueDate("2030-05-18");
    expect(model.getState().submitError).toBeNull();
  });
});
