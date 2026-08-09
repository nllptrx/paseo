import { describe, expect, it } from "vitest";
import {
  openNewTaskForm,
  suggestAvailableTaskProjectPrefix,
  suggestTaskProjectPrefix,
} from "./new-task-form-model";
import type { TaskProject } from "@getpaseo/protocol/tasks/types";

const project: TaskProject = {
  id: "tp_1",
  name: "Paseo",
  prefix: "PSE",
  color: "#fff",
  paseoProjectId: "proj-1",
  createdAt: "2026-01-01T00:00:00.000Z",
};

function openWithProject(existing: TaskProject | null) {
  return openNewTaskForm({
    serverId: "srv",
    project: existing,
    paseoProjectId: "proj-1",
    suggestedProjectName: "Paseo Mobile",
    initialStatus: "todo",
  });
}

describe("suggestTaskProjectPrefix", () => {
  it("takes the first three alphanumerics, uppercased", () => {
    expect(suggestTaskProjectPrefix("Paseo Mobile")).toBe("PAS");
    expect(suggestTaskProjectPrefix("a-b 2c!")).toBe("AB2");
    expect(suggestTaskProjectPrefix("")).toBe("");
  });
});

describe("suggestAvailableTaskProjectPrefix", () => {
  it("adds the first free suffix when another project owns the suggestion", () => {
    expect(
      suggestAvailableTaskProjectPrefix("Paseo", [
        { prefix: "PAS" },
        { prefix: "PAS2" },
        { prefix: "PAS3" },
      ]),
    ).toBe("PAS4");
  });
});

describe("openNewTaskForm", () => {
  it("needs only a title when the tracker project exists", () => {
    const model = openWithProject(project);
    expect(model.getState().needsProject).toBe(false);
    expect(model.getState().canSubmit).toBe(false);

    model.setTitle("Ship it");
    expect(model.getState().canSubmit).toBe(true);
    expect(model.getState().projectId).toBe("tp_1");
  });

  it("seeds project fields from the suggestion when the capture must create one", () => {
    const model = openWithProject(null);
    const state = model.getState();
    expect(state.needsProject).toBe(true);
    expect(state.projectName).toBe("Paseo Mobile");
    expect(state.prefix).toBe("PAS");

    model.setTitle("Ship it");
    expect(model.getState().canSubmit).toBe(true);
    model.setPrefix("");
    expect(model.getState().canSubmit).toBe(false);
  });

  it("blocks resubmission while submitting and clears the error on new input", () => {
    const model = openWithProject(project);
    model.setTitle("Ship it");
    model.setSubmitting(true);
    expect(model.getState().canSubmit).toBe(false);

    model.setSubmitError("boom");
    expect(model.getState().isSubmitting).toBe(false);
    expect(model.getState().submitError).toBe("boom");

    model.setTitle("Ship it again");
    expect(model.getState().submitError).toBeNull();
    expect(model.getState().canSubmit).toBe(true);
  });

  it("stops publishing after close", () => {
    const model = openWithProject(project);
    let notified = 0;
    model.subscribe(() => {
      notified += 1;
    });
    model.close();
    model.setTitle("late");
    expect(notified).toBe(0);
    expect(model.getState().title).toBe("");
  });
});
