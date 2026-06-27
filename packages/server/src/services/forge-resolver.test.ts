import { describe, expect, it, vi } from "vitest";

import { createForgeService } from "./forge-registry.js";
import { createForgeResolver, forgeForHost, parseRemoteHost } from "./forge-resolver.js";

describe("parseRemoteHost", () => {
  it("parses ssh and https remotes", () => {
    expect(parseRemoteHost("git@github.com:owner/repo.git")).toBe("github.com");
    expect(parseRemoteHost("git@gitlab.example.com:group/sub/repo.git")).toBe("gitlab.example.com");
    expect(parseRemoteHost("https://gitlab.example.com/group/repo.git")).toBe("gitlab.example.com");
    expect(parseRemoteHost("not a url")).toBeNull();
  });
});

describe("forgeForHost", () => {
  it("maps github.com to github and gitlab hosts to gitlab", () => {
    expect(forgeForHost("github.com")).toBe("github");
    expect(forgeForHost("gitlab.example.com")).toBe("gitlab");
    expect(forgeForHost("gitlab.com")).toBe("gitlab");
  });

  it("returns null for hosts with no known adapter", () => {
    expect(forgeForHost("example.com")).toBeNull();
    expect(forgeForHost("bitbucket.org")).toBeNull();
  });
});

describe("createForgeResolver", () => {
  it("resolves a github.com remote to the github forge", async () => {
    const resolver = createForgeResolver({
      resolveRemoteUrl: async () => "git@github.com:owner/repo.git",
    });
    const resolution = await resolver.resolve("/repo");
    expect(resolution).toMatchObject({ forge: "github", host: "github.com" });
    expect(resolution?.service.getCurrentPullRequestStatus).toBeTypeOf("function");
  });

  it("resolves a self-managed GitLab remote to the gitlab forge", async () => {
    const resolver = createForgeResolver({
      resolveRemoteUrl: async () => "git@gitlab.example.com:example-group/example-project.git",
    });
    const resolution = await resolver.resolve("/repo");
    expect(resolution).toMatchObject({ forge: "gitlab", host: "gitlab.example.com" });
  });

  it("returns null when the cwd has no origin remote", async () => {
    const resolver = createForgeResolver({ resolveRemoteUrl: async () => null });
    expect(await resolver.resolve("/repo")).toBeNull();
  });

  it("reuses one adapter instance per forge across resolutions", async () => {
    let built = 0;
    const resolver = createForgeResolver({
      resolveRemoteUrl: async () => "git@gitlab.example.com:group/repo.git",
      createService: (forge) => {
        built += 1;
        return createForgeService(forge);
      },
    });
    const first = await resolver.resolve("/a");
    const second = await resolver.resolve("/b");
    expect(built).toBe(1);
    expect(first?.service).toBe(second?.service);
  });

  it("detects a self-managed GitLab host with no name hint via the per-host probe", async () => {
    const probeForge = vi.fn(async () => "gitlab");
    const resolver = createForgeResolver({
      resolveRemoteUrl: async () => "git@git.acme.internal:team/repo.git",
      probeForge,
    });
    const resolution = await resolver.resolve("/repo");
    expect(resolution).toMatchObject({ forge: "gitlab", host: "git.acme.internal" });
    expect(probeForge).toHaveBeenCalledWith("git.acme.internal");
  });

  it("skips the probe when the name heuristic already resolves the host", async () => {
    const probeForge = vi.fn(async () => null);
    const resolver = createForgeResolver({
      resolveRemoteUrl: async () => "git@github.com:owner/repo.git",
      probeForge,
    });
    const resolution = await resolver.resolve("/repo");
    expect(resolution).toMatchObject({ forge: "github", host: "github.com" });
    expect(probeForge).not.toHaveBeenCalled();
  });

  it("returns null and probes a foreign host only once", async () => {
    const probeForge = vi.fn(async () => null);
    const resolver = createForgeResolver({
      resolveRemoteUrl: async () => "git@bitbucket.org:owner/repo.git",
      probeForge,
    });
    expect(await resolver.resolve("/a")).toBeNull();
    expect(await resolver.resolve("/b")).toBeNull();
    expect(probeForge).toHaveBeenCalledTimes(1);
  });

  it("lets the synchronous resolveFromRemoteUrl reuse a probed forge", async () => {
    const url = "git@git.acme.internal:team/repo.git";
    const probeForge = vi.fn(async () => "gitlab");
    const resolver = createForgeResolver({
      resolveRemoteUrl: async () => url,
      probeForge,
    });
    expect(resolver.resolveFromRemoteUrl(url)).toBeNull();
    await resolver.resolve("/repo");
    expect(resolver.resolveFromRemoteUrl(url)).toMatchObject({
      forge: "gitlab",
      host: "git.acme.internal",
    });
    expect(probeForge).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent probes of the same host into a single probe", async () => {
    let resolveProbe: ((forge: string | null) => void) | undefined;
    const probeForge = vi.fn(
      () =>
        new Promise<string | null>((resolve) => {
          resolveProbe = resolve;
        }),
    );
    const url = "git@git.acme.internal:team/repo.git";
    const resolver = createForgeResolver({ probeForge });
    const first = resolver.resolveFromRemoteUrlAsync(url);
    const second = resolver.resolveFromRemoteUrlAsync(url);
    resolveProbe?.("gitlab");
    const [a, b] = await Promise.all([first, second]);
    expect(a).toMatchObject({ forge: "gitlab", host: "git.acme.internal" });
    expect(b).toMatchObject({ forge: "gitlab", host: "git.acme.internal" });
    expect(probeForge).toHaveBeenCalledTimes(1);
  });
});
