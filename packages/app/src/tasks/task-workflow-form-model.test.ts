import { describe, expect, it } from "vitest";
import {
  buildTaskWorkflowSteps,
  openTaskWorkflowForm,
  type TaskWorkflowFormModel,
  type TaskWorkflowFormProviderOption,
  type TaskWorkflowFormSnapshot,
} from "./task-workflow-form-model";

const SNAPSHOT: TaskWorkflowFormSnapshot = {
  serverId: "host-a",
  taskId: "task-1",
};

const PROVIDERS: TaskWorkflowFormProviderOption[] = [
  { provider: "claude", available: true },
  { provider: "codex", available: false },
  { provider: "copilot", available: true },
];

function firstStepKey(model: TaskWorkflowFormModel): string {
  const key = model.getState().steps[0]?.key;
  if (!key) {
    throw new Error("expected the form to open with a step");
  }
  return key;
}

/** Fills in everything `canSubmit` requires, so a test can focus on one thing. */
function completeFirstStep(model: TaskWorkflowFormModel): string {
  const key = firstStepKey(model);
  model.setStepName(key, "Build");
  model.setStepPrompt(key, "do the work");
  return key;
}

describe("task workflow form model", () => {
  it("opens with one step and cannot submit until a provider snapshot arrives", () => {
    const model = openTaskWorkflowForm(SNAPSHOT);
    const state = model.getState();
    expect(state.providerOptions).toEqual([]);
    expect(state.steps).toHaveLength(1);
    expect(state.steps[0]?.provider).toBeNull();
    expect(state.autoContinue).toBe(true);
    expect(state.providerResolutionStatus).toBe("pending");
    expect(state.canSubmit).toBe(false);
  });

  it("continues new plans automatically unless the author turns it off", () => {
    const model = openTaskWorkflowForm({ ...SNAPSHOT, availableProviders: PROVIDERS });
    completeFirstStep(model);
    model.addStep();

    expect(model.getState().steps.map((step) => step.trigger)).toEqual(["manual", "immediate"]);

    model.setAutoContinue(false);
    expect(model.getState().steps.map((step) => step.trigger)).toEqual(["manual", "manual"]);

    model.setAutoContinue(true);
    expect(model.getState().steps.map((step) => step.trigger)).toEqual(["manual", "immediate"]);
  });

  it("reads automatic continuation from an existing plan", () => {
    const storedStep = {
      id: "stp_1",
      name: "Build",
      prompt: "Build it",
      agents: [{ provider: "claude" as const }],
      completion: "all" as const,
      workspace: { mode: "worktree" as const },
      requireChanges: true,
      runs: [],
    };
    const automatic = openTaskWorkflowForm({
      ...SNAPSHOT,
      existingSteps: [
        { ...storedStep, trigger: { type: "manual" as const } },
        { ...storedStep, id: "stp_2", trigger: { type: "immediate" as const } },
      ],
    });
    const paused = openTaskWorkflowForm({
      ...SNAPSHOT,
      existingSteps: [
        { ...storedStep, trigger: { type: "manual" as const } },
        { ...storedStep, id: "stp_2", trigger: { type: "manual" as const } },
      ],
    });

    expect(automatic.getState().autoContinue).toBe(true);
    expect(paused.getState().autoContinue).toBe(false);
  });

  it("seeds the opening step's provider from a snapshot that is already known", () => {
    const model = openTaskWorkflowForm({ ...SNAPSHOT, availableProviders: PROVIDERS });
    const state = model.getState();
    expect(state.providerOptions.map((option) => option.value)).toEqual(["claude", "copilot"]);
    expect(state.steps[0]?.provider).toBe("claude");
    expect(state.providerResolutionStatus).toBe("complete");
  });

  it("applies a late snapshot and drops providers the host cannot run", () => {
    const model = openTaskWorkflowForm(SNAPSHOT);
    model.applyProviderSnapshot("host-a", PROVIDERS);
    expect(model.getState().providerOptions.map((option) => option.value)).toEqual([
      "claude",
      "copilot",
    ]);
    expect(model.getState().steps[0]?.provider).toBe("claude");
  });

  it("ignores a provider snapshot for a different server", () => {
    const model = openTaskWorkflowForm(SNAPSHOT);
    model.applyProviderSnapshot("host-b", PROVIDERS);
    expect(model.getState().providerResolutionStatus).toBe("pending");
  });

  it("keeps a step's provider across a refresh when it is still available", () => {
    const model = openTaskWorkflowForm({ ...SNAPSHOT, availableProviders: PROVIDERS });
    const key = firstStepKey(model);
    model.setStepAgent(key, { provider: "copilot", model: "gpt-5" });
    model.applyProviderSnapshot("host-a", PROVIDERS);
    expect(model.getState().steps[0]?.provider).toBe("copilot");
    expect(model.getState().steps[0]?.model).toBe("gpt-5");
  });

  /** A host that cannot run a provider right now has not made the author change
   * their mind about it. Rewriting the step here would edit a workflow someone
   * only opened to look at. */
  it("keeps a step's provider when the host stops offering it", () => {
    const model = openTaskWorkflowForm({ ...SNAPSHOT, availableProviders: PROVIDERS });
    const key = firstStepKey(model);
    model.setStepAgent(key, { provider: "copilot", model: "gpt-5" });
    model.applyProviderSnapshot("host-a", [{ provider: "claude", available: true }]);
    expect(model.getState().steps[0]?.provider).toBe("copilot");
    expect(model.getState().steps[0]?.model).toBe("gpt-5");
    // Still listed, or the trigger would read as though nothing were chosen.
    expect(model.getState().providerOptions.map((option) => option.value)).toContain("copilot");
  });

  /** The daemon refuses a first step that waits for a step before it, so the
   * form must not be able to author one by reordering. */
  it("drops previous-step choices from a step moved to the front", () => {
    const model = openTaskWorkflowForm({ ...SNAPSHOT, availableProviders: PROVIDERS });
    completeFirstStep(model);
    model.addStep();
    const second = model.getState().steps[1]?.key ?? "";
    model.setStepWorkspaceMode(second, "reuse_previous");

    model.moveStep(second, -1);

    const moved = model.getState().steps[0];
    expect(moved?.key).toBe(second);
    expect(moved?.workspaceMode).toBe("worktree");
    expect(moved?.trigger).toBe("manual");
    expect(model.getState().steps[1]?.trigger).toBe("immediate");
  });

  it("requires every step complete before it can submit", () => {
    const model = openTaskWorkflowForm({ ...SNAPSHOT, availableProviders: PROVIDERS });
    const key = completeFirstStep(model);
    expect(model.getState().canSubmit).toBe(true);

    model.addStep();
    // The new action has no name yet, so the workflow is not submittable.
    expect(model.getState().canSubmit).toBe(false);

    const second = model.getState().steps[1]?.key ?? "";
    model.setStepName(second, "Review");
    model.setStepPrompt(second, "check the work");
    expect(model.getState().canSubmit).toBe(true);

    model.setStepPrompt(key, "   ");
    expect(model.getState().canSubmit).toBe(true);
    expect(buildTaskWorkflowSteps(model.getState())?.[0]?.prompt).toBe("Build");
  });

  it("inherits the previous step's agent when adding a step", () => {
    const model = openTaskWorkflowForm({ ...SNAPSHOT, availableProviders: PROVIDERS });
    model.setStepAgent(firstStepKey(model), { provider: "copilot", model: null });
    model.addStep();
    expect(model.getState().steps[1]?.provider).toBe("copilot");
  });

  it("reorders steps and keeps the last one from being removed", () => {
    const model = openTaskWorkflowForm({ ...SNAPSHOT, availableProviders: PROVIDERS });
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
    const model = openTaskWorkflowForm({ ...SNAPSHOT, availableProviders: PROVIDERS });
    let notifications = 0;
    model.subscribe(() => {
      notifications += 1;
    });
    model.close();
    model.setStepName(firstStepKey(model), "after close");
    expect(notifications).toBe(0);
  });

  it("builds a multi-step workflow payload carrying each step's agent, workspace and trigger", () => {
    const model = openTaskWorkflowForm({ ...SNAPSHOT, availableProviders: PROVIDERS });
    const first = completeFirstStep(model);
    model.setStepAgent(first, { provider: "claude", model: "claude-opus-5" });
    model.setStepWorkspaceMode(first, "worktree_per_agent");

    model.addStep();
    const second = model.getState().steps[1]?.key ?? "";
    model.setStepName(second, "Review");
    model.setStepPrompt(second, "check the work");
    model.setStepAgent(second, { provider: "copilot", model: null });
    model.setStepWorkspaceMode(second, "reuse_previous");

    expect(buildTaskWorkflowSteps(model.getState())).toEqual([
      {
        name: "Build",
        prompt: "do the work",
        agents: [{ provider: "claude", model: "claude-opus-5" }],
        completion: "all",
        workspace: { mode: "worktree_per_agent" },
        trigger: { type: "manual" },
        requireChanges: true,
      },
      {
        name: "Review",
        prompt: "check the work",
        // No model set means the provider's default, so none is sent.
        agents: [{ provider: "copilot" }],
        completion: "all",
        workspace: { mode: "reuse_previous" },
        trigger: { type: "immediate" },
        requireChanges: true,
      },
    ]);
  });

  it("returns no payload while the form is incomplete", () => {
    const model = openTaskWorkflowForm({ ...SNAPSHOT, availableProviders: PROVIDERS });
    expect(buildTaskWorkflowSteps(model.getState())).toBeNull();
  });
  /** A blank field asks for nothing: an empty command must not become a step
   * that runs the empty string and fails every time. */
  it("leaves the evidence fields off the payload when they are blank", () => {
    const model = openTaskWorkflowForm({ serverId: "srv", taskId: "tsk" });
    model.setStepName(model.getState().steps[0].key, "Build");
    model.setStepPrompt(model.getState().steps[0].key, "do it");
    model.setStepAgent(model.getState().steps[0].key, { provider: "claude", model: null });

    const [step] = buildTaskWorkflowSteps(model.getState()) ?? [];
    expect(step).not.toHaveProperty("verify");
    expect(step).not.toHaveProperty("timeoutMs");
    expect(step.requireChanges).toBe(true);
  });

  it("turns a typed command line and minutes into what the wire wants", () => {
    const model = openTaskWorkflowForm({ serverId: "srv", taskId: "tsk" });
    const key = model.getState().steps[0].key;
    model.setStepName(key, "Build");
    model.setStepPrompt(key, "do it");
    model.setStepAgent(key, { provider: "claude", model: null });
    model.setStepVerifyCommand(key, "  npm  run   test  ");
    model.setStepTimeoutMinutes(key, "30");

    const [step] = buildTaskWorkflowSteps(model.getState()) ?? [];
    expect(step.verify).toEqual({ command: ["npm", "run", "test"] });
    expect(step.timeoutMs).toBe(1_800_000);
  });

  /** Editing has to start from what is stored, or saving would replace the
   * evidence the step already asked for. */
  it("reads stored evidence back into the form", () => {
    const model = openTaskWorkflowForm({
      serverId: "srv",
      taskId: "tsk",
      existingSteps: [
        {
          id: "stp_1",
          name: "Build",
          prompt: "do it",
          agents: [{ provider: "claude" }],
          completion: "all",
          workspace: { mode: "worktree" },
          trigger: { type: "manual" },
          requireChanges: true,
          verify: { command: ["npm", "test"] },
          timeoutMs: 600_000,
          runs: [],
        },
      ],
    });

    const [step] = model.getState().steps;
    expect(step.verifyCommand).toBe("npm test");
    expect(step.timeoutMinutes).toBe("10");
    expect(step.requireChanges).toBe(true);
  });

  it("hydrates saved actions that arrive after the form opens", () => {
    const model = openTaskWorkflowForm({ serverId: "srv", taskId: "tsk" });

    model.applyExistingSteps("srv", "tsk", [
      {
        id: "stp_1",
        name: "Inspect the project",
        prompt: "Read the relevant files before making changes.",
        agents: [{ provider: "claude" }],
        completion: "all",
        workspace: { mode: "worktree" },
        trigger: { type: "manual" },
        runs: [],
      },
    ]);

    expect(model.getState().steps).toMatchObject([
      {
        name: "Inspect the project",
        prompt: "Read the relevant files before making changes.",
        provider: "claude",
      },
    ]);
  });

  it("hydrates saved actions after an empty workflow snapshot", () => {
    const model = openTaskWorkflowForm({
      serverId: "srv",
      taskId: "tsk",
      existingSteps: [],
    });

    model.applyExistingSteps("srv", "tsk", [
      {
        id: "stp_1",
        name: "Inspect the project",
        prompt: "Read the relevant files before making changes.",
        agents: [{ provider: "claude" }],
        completion: "all",
        workspace: { mode: "worktree" },
        trigger: { type: "manual" },
        runs: [],
      },
    ]);

    expect(model.getState().steps[0]?.name).toBe("Inspect the project");
  });

  it("does not replace form edits when a later snapshot repeats saved actions", () => {
    const storedStep = {
      id: "stp_1",
      name: "Inspect the project",
      prompt: "Read first.",
      agents: [{ provider: "claude" as const }],
      completion: "all" as const,
      workspace: { mode: "worktree" as const },
      trigger: { type: "manual" as const },
      runs: [],
    };
    const model = openTaskWorkflowForm({
      serverId: "srv",
      taskId: "tsk",
      existingSteps: [storedStep],
    });
    model.setStepName(firstStepKey(model), "User edit");

    model.applyExistingSteps("srv", "tsk", [{ ...storedStep, name: "RPC refresh" }]);

    expect(model.getState().steps[0]?.name).toBe("User edit");
  });

  /** The first agent is editable as one execution configuration. Fan-out and
   * workflow settings outside the editor still survive the same save. */
  it("saves the first agent configuration and carries unsupported settings", () => {
    const model = openTaskWorkflowForm({
      serverId: "srv",
      taskId: "tsk",
      availableProviders: PROVIDERS,
      existingSteps: [
        {
          id: "stp_1",
          name: "Build",
          prompt: "do it",
          agents: [
            {
              provider: "claude",
              model: "opus",
              modeId: "plan",
              thinkingOptionId: "high",
              featureValues: { fast_mode: true },
            },
            { provider: "codex" },
          ],
          completion: "all",
          workspace: { mode: "existing", workspaceId: "wsp_7" },
          trigger: { type: "schedule", cadence: { type: "every", everyMs: 1_800_000 } },
          runs: [],
        },
      ],
    });

    const key = model.getState().steps[0]?.key ?? "";
    model.setStepName(key, "Build it");
    model.setStepMode(key, "full-access");
    model.setStepThinking(key, "xhigh");
    model.setStepFeatureValues(key, { fast_mode: false });

    const [saved] = buildTaskWorkflowSteps(model.getState()) ?? [];
    expect(saved.existingStepId).toBe("stp_1");
    expect(saved.name).toBe("Build it");
    expect(saved.agents).toHaveLength(2);
    expect(saved.agents[0]).toMatchObject({
      modeId: "full-access",
      thinkingOptionId: "xhigh",
      featureValues: { fast_mode: false },
    });
    expect(saved.agents[1]).toEqual({ provider: "codex" });
    expect(saved.workspace).toEqual({ mode: "existing", workspaceId: "wsp_7" });
    expect(saved.trigger).toEqual({
      type: "schedule",
      cadence: { type: "every", everyMs: 1_800_000 },
    });
  });
});
