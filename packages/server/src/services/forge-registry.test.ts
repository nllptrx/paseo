import { describe, expect, it } from "vitest";

import { createForgeService, isKnownForge, knownForgeIds } from "./forge-registry.js";

describe("forge registry", () => {
  it("builds the registered adapters", () => {
    const github = createForgeService("github");
    const gitlab = createForgeService("gitlab");
    expect(github?.getCurrentPullRequestStatus).toBeTypeOf("function");
    expect(gitlab?.getCurrentPullRequestStatus).toBeTypeOf("function");
  });

  it("returns null for an unregistered forge", () => {
    expect(createForgeService("bitbucket")).toBeNull();
  });

  it("knows which forges are registered", () => {
    expect(isKnownForge("github")).toBe(true);
    expect(isKnownForge("gitlab")).toBe(true);
    expect(isKnownForge("bitbucket")).toBe(false);
    expect(knownForgeIds()).toEqual(expect.arrayContaining(["github", "gitlab"]));
  });
});
