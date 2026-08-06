import { describe, expect, it } from "vitest";
import {
  buildKanbanPlanCreateBody,
  openKanbanPlanForm,
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

describe("kanban plan form model", () => {
  it("starts with no provider selected and cannot submit until a snapshot arrives", () => {
    const model = openKanbanPlanForm(SNAPSHOT);
    const state = model.getState();
    expect(state.providerOptions).toEqual([]);
    expect(state.selectedProvider).toBeNull();
    expect(state.providerResolutionStatus).toBe("pending");
    expect(state.canSubmit).toBe(false);
  });

  it("seeds provider options from the opening snapshot when already known", () => {
    const model = openKanbanPlanForm({ ...SNAPSHOT, availableProviders: PROVIDERS });
    const state = model.getState();
    expect(state.providerOptions.map((option) => option.value)).toEqual(["claude", "copilot"]);
    expect(state.selectedProvider).toBe("claude");
    expect(state.providerResolutionStatus).toBe("complete");
  });

  it("applies a late provider snapshot, filters unavailable providers, and defaults the selection", () => {
    const model = openKanbanPlanForm(SNAPSHOT);
    model.applyProviderSnapshot(SNAPSHOT.serverId, PROVIDERS);
    const state = model.getState();
    expect(state.providerOptions.map((option) => option.value)).toEqual(["claude", "copilot"]);
    expect(state.selectedProvider).toBe("claude");
    expect(state.selectedProviderDisplay?.label).toBe("Claude");
    expect(state.providerResolutionStatus).toBe("complete");
  });

  it("ignores a provider snapshot for a different server", () => {
    const model = openKanbanPlanForm(SNAPSHOT);
    model.applyProviderSnapshot("other-host", PROVIDERS);
    expect(model.getState().providerResolutionStatus).toBe("pending");
  });

  it("keeps the current selection across a snapshot refresh when it is still available", () => {
    const model = openKanbanPlanForm({ ...SNAPSHOT, availableProviders: PROVIDERS });
    model.setProvider("copilot");
    model.applyProviderSnapshot(SNAPSHOT.serverId, PROVIDERS);
    expect(model.getState().selectedProvider).toBe("copilot");
  });

  it("falls back to the first available provider when the current selection drops out", () => {
    const model = openKanbanPlanForm({ ...SNAPSHOT, availableProviders: PROVIDERS });
    model.setProvider("copilot");
    model.applyProviderSnapshot(SNAPSHOT.serverId, [{ provider: "claude", available: true }]);
    expect(model.getState().selectedProvider).toBe("claude");
  });

  it("derives canSubmit from title, prompt, and provider together", () => {
    const model = openKanbanPlanForm({ ...SNAPSHOT, availableProviders: PROVIDERS });
    expect(model.getState().canSubmit).toBe(false);
    model.setTitle("Ship the thing");
    expect(model.getState().canSubmit).toBe(false);
    model.setPrompt("Do the thing");
    expect(model.getState().canSubmit).toBe(true);
    model.setTitle("   ");
    expect(model.getState().canSubmit).toBe(false);
  });

  it("stops publishing after close", () => {
    const model = openKanbanPlanForm(SNAPSHOT);
    const listener = () => {
      throw new Error("should not be called after close");
    };
    model.subscribe(listener);
    model.close();
    expect(() => model.setTitle("still writing")).not.toThrow();
    expect(model.getState().title).toBe("");
  });

  it("builds the single-step manual workflow payload from the current state", () => {
    const model = openKanbanPlanForm({ ...SNAPSHOT, availableProviders: PROVIDERS });
    model.setTitle("Ship the thing");
    model.setPrompt("Do the thing");
    const body = buildKanbanPlanCreateBody(model.getState());
    expect(body).toEqual({
      type: "workflow",
      steps: [
        {
          name: "Ship the thing",
          prompt: "Do the thing",
          agents: [{ provider: "claude" }],
          completion: "all",
          workspace: { mode: "worktree" },
          trigger: { type: "manual" },
        },
      ],
    });
  });

  it("returns null when no provider is selected", () => {
    const model = openKanbanPlanForm(SNAPSHOT);
    expect(buildKanbanPlanCreateBody(model.getState())).toBeNull();
  });
});
