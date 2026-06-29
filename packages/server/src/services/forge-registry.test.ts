import { describe, expect, it } from "vitest";

import {
  createForgeService,
  defaultForgeRegistry,
  ForgeRegistry,
  isKnownForge,
  knownForgeIds,
  registerForgeAdapter,
} from "./forge-registry.js";
import { createGitHubService } from "./github-service.js";

describe("forge registry", () => {
  it("builds the registered adapters", () => {
    const github = createForgeService("github");
    const gitlab = createForgeService("gitlab");
    const gitea = createForgeService("gitea");
    const forgejo = createForgeService("forgejo");
    expect(github?.getCurrentPullRequestStatus).toBeTypeOf("function");
    expect(gitlab?.getCurrentPullRequestStatus).toBeTypeOf("function");
    expect(gitea?.getCurrentPullRequestStatus).toBeTypeOf("function");
    expect(forgejo?.getCurrentPullRequestStatus).toBeTypeOf("function");
  });

  it("returns null for an unregistered forge", () => {
    expect(createForgeService("bitbucket")).toBeNull();
  });

  it("knows which forges are registered", () => {
    expect(isKnownForge("github")).toBe(true);
    expect(isKnownForge("gitlab")).toBe(true);
    expect(isKnownForge("gitea")).toBe(true);
    expect(isKnownForge("forgejo")).toBe(true);
    expect(isKnownForge("bitbucket")).toBe(false);
    expect(knownForgeIds()).toEqual(
      expect.arrayContaining(["github", "gitlab", "gitea", "forgejo"]),
    );
  });

  it("registers a third-party adapter without changing the registry implementation", () => {
    const unregister = registerForgeAdapter("bitbucket", {
      createService: createGitHubService,
      matchesHost: (host) => host === "bitbucket.org",
    });
    try {
      expect(isKnownForge("bitbucket")).toBe(true);
      expect(createForgeService("bitbucket")?.getCurrentPullRequestStatus).toBeTypeOf("function");
    } finally {
      unregister();
    }
    expect(isKnownForge("bitbucket")).toBe(false);
  });

  it("lets adapters own heuristic and asynchronous host detection", async () => {
    const registry = new ForgeRegistry([
      [
        "bitbucket",
        {
          createService: createGitHubService,
          matchesHost: (host) => host === "bitbucket.org",
          probeHost: async (host) => host === "git.acme.internal",
        },
      ],
    ]);

    expect(registry.matchHost("bitbucket.org")).toBe("bitbucket");
    await expect(registry.probeHost("git.acme.internal")).resolves.toBe("bitbucket");
  });

  it("does not infer self-managed forges from host substrings", () => {
    expect(defaultForgeRegistry.matchHost("gitea-forgejo.example.org")).toBeNull();
    expect(defaultForgeRegistry.matchHost("gitlab.example.org")).toBeNull();
    expect(defaultForgeRegistry.matchHost("notgitlab.example.org")).toBeNull();
  });

  it("rejects ambiguous host detection instead of depending on registration order", async () => {
    const registry = new ForgeRegistry([
      [
        "first",
        {
          createService: createGitHubService,
          matchesHost: () => true,
          probeHost: async () => true,
        },
      ],
      [
        "second",
        {
          createService: createGitHubService,
          matchesHost: () => true,
          probeHost: async () => true,
        },
      ],
    ]);

    expect(() => registry.matchHost("git.acme.internal")).toThrow(/Multiple forge adapters/);
    await expect(registry.probeHost("git.acme.internal")).rejects.toThrow(
      /Multiple forge adapters/,
    );
  });
});
