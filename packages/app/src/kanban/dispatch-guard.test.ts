import type { Step } from "@getpaseo/protocol/kanban/types";
import { describe, expect, it } from "vitest";
import { resolveStepDispatchBlock, type KanbanProviderAvailability } from "./dispatch-guard";

function step(providers: string[]): Step {
  return {
    id: "step-1",
    name: "Build",
    prompt: "build it",
    agents: providers.map((provider) => ({ provider })),
    completion: "all",
    workspace: { mode: "worktree" },
    trigger: { type: "manual" },
    runs: [],
  } as Step;
}

const READY: KanbanProviderAvailability[] = [
  { provider: "claude", available: true, error: null },
  { provider: "codex", available: false, error: "codex is not signed in" },
];

describe("resolveStepDispatchBlock", () => {
  it("passes a step whose agents are all available", () => {
    expect(resolveStepDispatchBlock({ step: step(["claude"]), providers: READY })).toBeNull();
  });

  it("names the unavailable provider and carries the host's reason", () => {
    expect(resolveStepDispatchBlock({ step: step(["codex"]), providers: READY })).toEqual({
      provider: "codex",
      reason: "codex is not signed in",
    });
  });

  it("blocks a provider the host does not list at all", () => {
    expect(resolveStepDispatchBlock({ step: step(["opencode"]), providers: READY })).toEqual({
      provider: "opencode",
      reason: null,
    });
  });

  it("reports the first unusable agent of a multi-agent step", () => {
    expect(resolveStepDispatchBlock({ step: step(["claude", "codex"]), providers: READY })).toEqual(
      {
        provider: "codex",
        reason: "codex is not signed in",
      },
    );
  });

  it("lets the dispatch through while the host has not answered", () => {
    expect(resolveStepDispatchBlock({ step: step(["codex"]), providers: null })).toBeNull();
  });
});
