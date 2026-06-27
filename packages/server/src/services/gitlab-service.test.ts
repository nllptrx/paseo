import { describe, expect, it } from "vitest";

import {
  type CreateGitLabServiceOptions,
  createGitLabService,
  GlabAuthenticationError,
  GlabCliMissingError,
  GlabCommandError,
  type GlabCommandResult,
  type GlabCommandRunner,
} from "./gitlab-service.js";

type Responder = (args: string[]) => GlabCommandResult | Promise<GlabCommandResult>;

function ok(stdout: string): GlabCommandResult {
  return { stdout, stderr: "" };
}

function makeService(responder: Responder, overrides: Partial<CreateGitLabServiceOptions> = {}) {
  const calls: string[][] = [];
  const runner: GlabCommandRunner = async (args) => {
    calls.push(args);
    return responder(args);
  };
  const service = createGitLabService({
    runner,
    resolveGlabPath: async () => "/usr/bin/glab",
    resolveRemoteUrl: async () => "git@gitlab.example.com:example-group/example-project.git",
    ...overrides,
  });
  return { service, calls };
}

const OPEN_MR = {
  iid: 14,
  title: "chore(release): 0.4.0",
  web_url: "https://gitlab.example.com/example-group/example-project/-/merge_requests/14",
  state: "opened",
  source_branch: "release/v0.4.0",
  target_branch: "main",
  draft: false,
  work_in_progress: false,
  has_conflicts: false,
  merged_at: null,
  detailed_merge_status: "mergeable",
  description: "Release notes",
  labels: ["release"],
  updated_at: "2026-06-25T19:00:00.000Z",
  references: { full: "example-group/example-project!14", short: "!14" },
  head_pipeline: { status: "success" },
};

describe("createGitLabService", () => {
  it("maps a glab merge request view to the neutral current PR status", async () => {
    const { service } = makeService(() => ok(JSON.stringify(OPEN_MR)));

    const status = await service.getCurrentPullRequestStatus({
      cwd: "/repo",
      headRef: "release/v0.4.0",
    });

    expect(status).toMatchObject({
      number: 14,
      url: "https://gitlab.example.com/example-group/example-project/-/merge_requests/14",
      title: "chore(release): 0.4.0",
      state: "open",
      baseRefName: "main",
      headRefName: "release/v0.4.0",
      isMerged: false,
      isDraft: false,
      mergeable: "MERGEABLE",
      checksStatus: "success",
      reviewDecision: null,
      repoOwner: "example-group",
      repoName: "example-project",
      projectPath: "example-group/example-project",
    });
    expect(status?.forgeSpecific).toMatchObject({
      forge: "gitlab",
      detailedMergeStatus: "mergeable",
      hasConflicts: false,
      pipelineStatus: "success",
      mergeWhenPipelineSucceeds: false,
    });
  });

  it("reports a conflicting merge request as CONFLICTING", async () => {
    const { service } = makeService(() =>
      ok(
        JSON.stringify({ ...OPEN_MR, has_conflicts: true, detailed_merge_status: "broken_status" }),
      ),
    );
    const status = await service.getCurrentPullRequestStatus({ cwd: "/repo", headRef: "x" });
    expect(status?.mergeable).toBe("CONFLICTING");
  });

  it("returns null when no merge request exists for the branch", async () => {
    const { service } = makeService(() => {
      throw { code: 1, stderr: "no open merge request available for 'feature/x'" };
    });
    const status = await service.getCurrentPullRequestStatus({
      cwd: "/repo",
      headRef: "feature/x",
    });
    expect(status).toBeNull();
  });

  it("lists merge requests as neutral PR summaries", async () => {
    const { service, calls } = makeService(() => ok(JSON.stringify([OPEN_MR])));
    const list = await service.listPullRequests({ cwd: "/repo", limit: 5 });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ number: 14, title: "chore(release): 0.4.0", state: "open" });
    expect(calls[0]).toEqual(["mr", "list", "-F", "json", "-P", "5"]);
  });

  it("creates a merge request and parses the URL and iid from glab output", async () => {
    const { service, calls } = makeService(() =>
      ok(
        "Creating merge request for release/v0.4.0 into main\n" +
          "https://gitlab.example.com/example-group/example-project/-/merge_requests/15\n",
      ),
    );
    const result = await service.createPullRequest({
      cwd: "/repo",
      repo: "example-group/example-project",
      title: "Ship it",
      head: "release/v0.4.0",
      base: "main",
      body: "Body",
    });
    expect(result).toEqual({
      url: "https://gitlab.example.com/example-group/example-project/-/merge_requests/15",
      number: 15,
    });
    expect(calls[0]).toEqual([
      "mr",
      "create",
      "--title",
      "Ship it",
      "--description",
      "Body",
      "--source-branch",
      "release/v0.4.0",
      "--target-branch",
      "main",
      "--yes",
    ]);
  });

  it("merges with the requested strategy when GitLab reports the MR as mergeable", async () => {
    const { service, calls } = makeService(() => ok(""));
    const result = await service.mergePullRequest({
      cwd: "/repo",
      prNumber: 14,
      mergeMethod: "squash",
      status: {
        forgeSpecific: {
          forge: "gitlab",
          detailedMergeStatus: "mergeable",
          hasConflicts: false,
          blockingDiscussionsResolved: true,
          approvalsRequired: 0,
          approvalsGiven: 0,
          pipelineStatus: "success",
          mergeWhenPipelineSucceeds: false,
        },
      },
    });
    expect(result).toEqual({ success: true });
    expect(calls[0]).toEqual(["mr", "merge", "14", "--auto-merge=false", "--yes", "--squash"]);
  });

  it("refuses a direct merge when GitLab does not report the MR as mergeable", async () => {
    const { service, calls } = makeService(() => ok(""));
    await expect(
      service.mergePullRequest({
        cwd: "/repo",
        prNumber: 14,
        mergeMethod: "merge",
        status: {
          forgeSpecific: {
            forge: "gitlab",
            detailedMergeStatus: "ci_still_running",
            hasConflicts: false,
            blockingDiscussionsResolved: true,
            approvalsRequired: 0,
            approvalsGiven: 0,
            pipelineStatus: "running",
            mergeWhenPipelineSucceeds: false,
          },
        },
      }),
    ).rejects.toThrow(/ready for direct merge/);
    expect(calls).toHaveLength(0);
  });

  it("reports authentication via a host-scoped glab auth status", async () => {
    const { service, calls } = makeService((args) => {
      if (args[0] === "auth") return ok("");
      throw new Error("unexpected");
    });
    await expect(service.isAuthenticated({ cwd: "/repo" })).resolves.toBe(true);
    expect(calls[0]).toEqual(["auth", "status", "--hostname", "gitlab.example.com"]);
  });

  it("reports unauthenticated when glab auth status fails", async () => {
    const { service } = makeService(() => {
      throw { code: 1, stderr: "401 Unauthorized" };
    });
    await expect(service.isAuthenticated({ cwd: "/repo" })).resolves.toBe(false);
  });

  it("reports unauthenticated when the cwd has no GitLab remote", async () => {
    const { service, calls } = makeService(() => ok(""), { resolveRemoteUrl: async () => null });
    await expect(service.isAuthenticated({ cwd: "/repo" })).resolves.toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("throws GlabCliMissingError when glab is not installed", async () => {
    const { service } = makeService(() => ok("{}"), { resolveGlabPath: async () => null });
    await expect(service.getPullRequest({ cwd: "/repo", number: 1 })).rejects.toBeInstanceOf(
      GlabCliMissingError,
    );
  });

  it("normalizes glab auth failures into GlabAuthenticationError", async () => {
    const { service } = makeService(() => {
      throw { code: 1, stderr: "error: 401 Unauthorized — not logged in" };
    });
    await expect(service.getPullRequest({ cwd: "/repo", number: 1 })).rejects.toBeInstanceOf(
      GlabAuthenticationError,
    );
  });

  it("surfaces non-JSON glab stdout as a GlabCommandError", async () => {
    const { service } = makeService(() => ok("not json at all"));
    await expect(service.getPullRequest({ cwd: "/repo", number: 1 })).rejects.toBeInstanceOf(
      GlabCommandError,
    );
  });

  it("surfaces schema-mismatched glab JSON as a GlabCommandError", async () => {
    const { service } = makeService(() => ok(JSON.stringify({ unexpected: true })));
    await expect(service.getPullRequest({ cwd: "/repo", number: 1 })).rejects.toBeInstanceOf(
      GlabCommandError,
    );
  });
});
