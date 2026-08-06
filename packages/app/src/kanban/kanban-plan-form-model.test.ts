import { describe, expect, it } from "vitest";
import {
  buildKanbanPlanCreateBody,
  openKanbanPlanForm,
  type KanbanPlanFormModel,
  type KanbanPlanFormProviderOption,
  type KanbanPlanFormSnapshot,
} from "./kanban-plan-form-model";

const SNAPSHOT: KanbanPlanFormSnapshot = {
  serverId: "host-a",
  kanbanId: "kanban-1",
  parentPlanId: null,
};

const PROVIDERS: KanbanPlanFormProviderOption[] = [
  { provider: "claude", available: true },
  { provider: "codex", available: false },
  { provider: "copilot", available: true },
];

function firstStepKey(model: KanbanPlanFormModel): string {
  const key = model.getState().steps[0]?.key;
  if (!key) {
    throw new Error("expected the form to open with a step");
  }
  return key;
}

/** Fills in everything `canSubmit` requires, so a test can focus on one thing. */
function completeFirstStep(model: KanbanPlanFormModel): string {
  const key = firstStepKey(model);
  model.setTitle("Ship it");
  model.setStepName(key, "Build");
  model.setStepPrompt(key, "do the work");
  return key;
}

describe("kanban plan form model", () => {
  it("opens with one step and cannot submit until a provider snapshot arrives", () => {
    const model = openKanbanPlanForm(SNAPSHOT);
    const state = model.getState();
    expect(state.providerOptions).toEqual([]);
    expect(state.steps).toHaveLength(1);
    expect(state.steps[0]?.provider).toBeNull();
    expect(state.providerResolutionStatus).toBe("pending");
    expect(state.canSubmit).toBe(false);
  });

  it("seeds the opening step's provider from a snapshot that is already known", () => {
    const model = openKanbanPlanForm({ ...SNAPSHOT, availableProviders: PROVIDERS });
    const state = model.getState();
    expect(state.providerOptions.map((option) => option.value)).toEqual(["claude", "copilot"]);
    expect(state.steps[0]?.provider).toBe("claude");
    expect(state.providerResolutionStatus).toBe("complete");
  });

  it("applies a late snapshot and drops providers the host cannot run", () => {
    const model = openKanbanPlanForm(SNAPSHOT);
    model.applyProviderSnapshot("host-a", PROVIDERS);
    expect(model.getState().providerOptions.map((option) => option.value)).toEqual([
      "claude",
      "copilot",
    ]);
    expect(model.getState().steps[0]?.provider).toBe("claude");
  });

  it("ignores a provider snapshot for a different server", () => {
    const model = openKanbanPlanForm(SNAPSHOT);
    model.applyProviderSnapshot("host-b", PROVIDERS);
    expect(model.getState().providerResolutionStatus).toBe("pending");
  });

  it("keeps a step's provider across a refresh when it is still available", () => {
    const model = openKanbanPlanForm({ ...SNAPSHOT, availableProviders: PROVIDERS });
    const key = firstStepKey(model);
    model.setStepAgent(key, { provider: "copilot", model: "gpt-5" });
    model.applyProviderSnapshot("host-a", PROVIDERS);
    expect(model.getState().steps[0]?.provider).toBe("copilot");
    expect(model.getState().steps[0]?.model).toBe("gpt-5");
  });

  it("falls back, and clears the model, when a step's provider drops out", () => {
    const model = openKanbanPlanForm({ ...SNAPSHOT, availableProviders: PROVIDERS });
    const key = firstStepKey(model);
    model.setStepAgent(key, { provider: "copilot", model: "gpt-5" });
    model.applyProviderSnapshot("host-a", [{ provider: "claude", available: true }]);
    expect(model.getState().steps[0]?.provider).toBe("claude");
    // A model id belongs to the provider that offered it.
    expect(model.getState().steps[0]?.model).toBeNull();
  });

  it("requires a title and every step complete before it can submit", () => {
    const model = openKanbanPlanForm({ ...SNAPSHOT, availableProviders: PROVIDERS });
    const key = completeFirstStep(model);
    expect(model.getState().canSubmit).toBe(true);

    model.addStep();
    // The new step has no name or prompt yet, so the plan is not submittable.
    expect(model.getState().canSubmit).toBe(false);

    const second = model.getState().steps[1]?.key ?? "";
    model.setStepName(second, "Review");
    model.setStepPrompt(second, "check the work");
    expect(model.getState().canSubmit).toBe(true);

    model.setStepPrompt(key, "   ");
    expect(model.getState().canSubmit).toBe(false);
  });

  it("inherits the previous step's agent when adding a step", () => {
    const model = openKanbanPlanForm({ ...SNAPSHOT, availableProviders: PROVIDERS });
    model.setStepAgent(firstStepKey(model), { provider: "copilot", model: null });
    model.addStep();
    expect(model.getState().steps[1]?.provider).toBe("copilot");
  });

  it("reorders steps and keeps the last one from being removed", () => {
    const model = openKanbanPlanForm({ ...SNAPSHOT, availableProviders: PROVIDERS });
    const first = firstStepKey(model);
    model.setStepName(first, "Build");
    model.addStep();
    const second = model.getState().steps[1]?.key ?? "";
    model.setStepName(second, "Review");

    model.moveStep(second, -1);
    expect(model.getState().steps.map((step) => step.name)).toEqual(["Review", "Build"]);

    // Off the end is a no-op rather than an error.
    model.moveStep(second, -1);
    expect(model.getState().steps.map((step) => step.name)).toEqual(["Review", "Build"]);

    model.removeStep(second);
    expect(model.getState().steps.map((step) => step.name)).toEqual(["Build"]);
    model.removeStep(first);
    expect(model.getState().steps).toHaveLength(1);
  });

  it("stops publishing after close", () => {
    const model = openKanbanPlanForm({ ...SNAPSHOT, availableProviders: PROVIDERS });
    let notifications = 0;
    model.subscribe(() => {
      notifications += 1;
    });
    model.close();
    model.setTitle("after close");
    expect(notifications).toBe(0);
  });

  it("builds a multi-step workflow payload carrying each step's agent, workspace and trigger", () => {
    const model = openKanbanPlanForm({ ...SNAPSHOT, availableProviders: PROVIDERS });
    const first = completeFirstStep(model);
    model.setStepAgent(first, { provider: "claude", model: "claude-opus-5" });
    model.setStepWorkspaceMode(first, "worktree_per_agent");

    model.addStep();
    const second = model.getState().steps[1]?.key ?? "";
    model.setStepName(second, "Review");
    model.setStepPrompt(second, "check the work");
    model.setStepAgent(second, { provider: "copilot", model: null });
    model.setStepWorkspaceMode(second, "reuse_previous");
    model.setStepTrigger(second, "immediate");

    expect(buildKanbanPlanCreateBody(model.getState())).toEqual({
      type: "workflow",
      steps: [
        {
          name: "Build",
          prompt: "do the work",
          agents: [{ provider: "claude", model: "claude-opus-5" }],
          completion: "all",
          workspace: { mode: "worktree_per_agent" },
          trigger: { type: "manual" },
        },
        {
          name: "Review",
          prompt: "check the work",
          // No model set means the provider's default, so none is sent.
          agents: [{ provider: "copilot" }],
          completion: "all",
          workspace: { mode: "reuse_previous" },
          trigger: { type: "immediate" },
        },
      ],
    });
  });

  it("returns no payload while the form is incomplete", () => {
    const model = openKanbanPlanForm({ ...SNAPSHOT, availableProviders: PROVIDERS });
    model.setTitle("Ship it");
    expect(buildKanbanPlanCreateBody(model.getState())).toBeNull();
  });
});
