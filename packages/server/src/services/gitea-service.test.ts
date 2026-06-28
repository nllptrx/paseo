import { describe, expect, it } from "vitest";

import type { PullRequestCommandStatus } from "./forge-service.js";
import {
  type CreateGiteaServiceOptions,
  createGiteaService,
  TeaAuthenticationError,
  type TeaCommandResult,
  type TeaCommandRunner,
} from "./gitea-service.js";

type Responder = (args: string[]) => TeaCommandResult | Promise<TeaCommandResult>;

function ok(stdout: string): TeaCommandResult {
  return { stdout, stderr: "" };
}

function makeService(responder: Responder, overrides: Partial<CreateGiteaServiceOptions> = {}) {
  const calls: string[][] = [];
  const runner: TeaCommandRunner = async (args) => {
    calls.push(args);
    return responder(args);
  };
  const service = createGiteaService({
    runner,
    resolveTeaPath: async () => "/usr/bin/tea",
    resolveRemoteUrl: async () => "https://gitea.com/example-user/sample-repo.git",
    ...overrides,
  });
  return { service, calls };
}

// `tea pr list -o json` shape: every value is a string, including
// numeric/boolean fields (index, mergeable, comments, ci).
const OPEN_PR = {
  index: "5",
  state: "open",
  author: "example-user",
  url: "https://gitea.com/example-user/sample-repo/pulls/5",
  title: "Add sample feature",
  body: "Implements the sample feature",
  mergeable: "true",
  base: "main",
  head: "feat/sample-change",
  created: "2026-06-26T09:00:00Z",
  updated: "2026-06-26T10:00:00Z",
  labels: "enhancement,review",
  comments: "2",
  ci: "success",
};

const CONFLICTING_PR = {
  ...OPEN_PR,
  index: "6",
  url: "https://gitea.com/example-user/sample-repo/pulls/6",
  head: "feat/conflict",
  mergeable: "false",
  ci: "failure",
};

const OPEN_ISSUE = {
  index: "3",
  state: "open",
  author: "example-user",
  url: "https://gitea.com/example-user/sample-repo/issues/3",
  title: "Login button misaligned",
  body: "On mobile the button overflows",
  labels: "bug",
  comments: "1",
  created: "2026-06-24T08:00:00Z",
  updated: "2026-06-24T09:00:00Z",
};

const TIMELINE_USER = {
  id: 213843,
  login: "example-user",
  login_name: "",
  source_id: 0,
  full_name: "",
  email: "1+example-user@noreply.gitea.com",
  avatar_url:
    "https://gitea.com/avatars/0000000000000000000000000000000000000000000000000000000000000000",
  html_url: "https://gitea.com/example-user",
  language: "",
  is_admin: false,
  last_login: "0001-01-01T00:00:00Z",
  created: "2026-06-27T18:29:03Z",
  restricted: false,
  active: false,
  prohibit_login: false,
  location: "",
  website: "",
  description: "",
  visibility: "public",
  followers_count: 0,
  following_count: 0,
  starred_repos_count: 0,
  username: "example-user",
};

// Shape of a `tea pr 1 -o json` response.
const TIMELINE_PR_VIEW = {
  id: 161481,
  index: 1,
  title: "Timeline fixture PR",
  state: "open",
  created: "2026-06-28T16:15:10Z",
  updated: "2026-06-28T16:16:18Z",
  labels: [],
  user: "example-user",
  body: "Sample pull request body.",
  assignees: [],
  url: "https://gitea.com/example-user/sample-repo/pulls/1",
  base: "main",
  head: "timeline-fixture",
  headSha: "5555555555555555555555555555555555555555",
  diffUrl: "https://gitea.com/example-user/sample-repo/pulls/1.diff",
  mergeable: true,
  hasMerged: false,
  mergedAt: null,
  closedAt: null,
  reviews: [
    {
      id: 2001,
      reviewer: "example-user",
      state: "COMMENT",
      body: "Timeline fixture general review comment.",
      created: "2026-06-28T16:15:28Z",
    },
    {
      id: 2002,
      reviewer: "example-user",
      state: "COMMENT",
      body: "Timeline fixture inline review.",
      created: "2026-06-28T16:16:18Z",
    },
  ],
  comments: [],
};

// `tea api repos/:owner/:repo/issues/:index/comments` shape.
const TIMELINE_ISSUE_COMMENTS = [
  {
    id: 1001,
    html_url:
      "https://gitea.com/example-user/sample-repo/pulls/1#issuecomment-1001",
    pull_request_url: "https://gitea.com/example-user/sample-repo/pulls/1",
    issue_url: "",
    user: TIMELINE_USER,
    original_author: "",
    original_author_id: 0,
    body: "Timeline fixture issue comment from tea api.",
    assets: [],
    created_at: "2026-06-28T16:15:18Z",
    updated_at: "2026-06-28T16:15:18Z",
  },
];

// `tea api repos/:owner/:repo/pulls/:index/reviews` shape.
const TIMELINE_REVIEWS = [
  {
    id: 2001,
    user: { ...TIMELINE_USER, email: "dev@example.com", language: "en-US", active: true },
    team: null,
    state: "COMMENT",
    body: "Timeline fixture general review comment.",
    commit_id: "5555555555555555555555555555555555555555",
    stale: false,
    official: false,
    dismissed: false,
    comments_count: 0,
    submitted_at: "2026-06-28T16:15:28Z",
    updated_at: "2026-06-28T16:15:28Z",
    html_url:
      "https://gitea.com/example-user/sample-repo/pulls/1#issuecomment-1002",
    pull_request_url: "https://gitea.com/example-user/sample-repo/pulls/1",
  },
  {
    id: 2002,
    user: { ...TIMELINE_USER, email: "dev@example.com", language: "en-US", active: true },
    team: null,
    state: "COMMENT",
    body: "Timeline fixture inline review.",
    commit_id: "5555555555555555555555555555555555555555",
    stale: false,
    official: false,
    dismissed: false,
    comments_count: 1,
    submitted_at: "2026-06-28T16:16:18Z",
    updated_at: "2026-06-28T16:16:18Z",
    html_url:
      "https://gitea.com/example-user/sample-repo/pulls/1#issuecomment-1004",
    pull_request_url: "https://gitea.com/example-user/sample-repo/pulls/1",
  },
];

// `tea api repos/:owner/:repo/pulls/:index/reviews/:reviewId/comments` shape.
const TIMELINE_REVIEW_COMMENTS = [
  {
    id: 1003,
    body: "Timeline fixture inline review comment.",
    user: { ...TIMELINE_USER, email: "dev@example.com", language: "en-US", active: true },
    resolver: null,
    pull_request_review_id: 2002,
    created_at: "2026-06-28T16:16:18Z",
    updated_at: "2026-06-28T16:16:18Z",
    path: "README.md",
    commit_id: "5555555555555555555555555555555555555555",
    original_commit_id: "",
    diff_hunk:
      "@@ -2,2 +2,3 @@\n-Sample timeline fixture\n\\ No newline at end of file\n+Sample timeline fixture.\n+",
    position: 4,
    original_position: 0,
    html_url:
      "https://gitea.com/example-user/sample-repo/pulls/1#issuecomment-1003",
    pull_request_url: "https://gitea.com/example-user/sample-repo/pulls/1",
  },
];

const LOGINS = [
  { name: "gitea.com", url: "https://gitea.com", ssh_host: "gitea.com", user: "example-user" },
];

function giteaMergeStatus(
  overrides: Partial<PullRequestCommandStatus> = {},
): PullRequestCommandStatus {
  return {
    forgeSpecific: { forge: "gitea", mergeable: true, hasMerged: false, ciStatus: "success" },
    ...overrides,
  };
}

describe("createGiteaService", () => {
  it("maps a tea pr list item to the neutral current PR status by head branch", async () => {
    const { service, calls } = makeService((args) => {
      if (args[0] === "pr" && args[1] === "list")
        return ok(JSON.stringify([OPEN_PR, CONFLICTING_PR]));
      throw new Error(`unexpected call: ${args.join(" ")}`);
    });

    const status = await service.getCurrentPullRequestStatus({
      cwd: "/repo",
      headRef: "feat/sample-change",
    });

    expect(status).toMatchObject({
      number: 5,
      url: "https://gitea.com/example-user/sample-repo/pulls/5",
      title: "Add sample feature",
      state: "open",
      baseRefName: "main",
      headRefName: "feat/sample-change",
      isMerged: false,
      mergeable: "MERGEABLE",
      checksStatus: "success",
      reviewDecision: null,
      repoOwner: "example-user",
      repoName: "sample-repo",
      projectPath: "example-user/sample-repo",
    });
    expect(status?.forgeSpecific).toEqual({
      forge: "gitea",
      mergeable: true,
      hasMerged: false,
      ciStatus: "success",
    });
    // Requests the explicit field set; tea's default omits url/mergeable/base/head/ci.
    expect(calls[0]).toContain("--fields");
    expect(calls[0]).toContain("-o");
    expect(calls[0]).toContain("json");
  });

  it("reports a conflicting PR as CONFLICTING with a failing CI", async () => {
    const { service } = makeService(() => ok(JSON.stringify([CONFLICTING_PR])));

    const status = await service.getCurrentPullRequestStatus({
      cwd: "/repo",
      headRef: "feat/conflict",
    });

    expect(status?.mergeable).toBe("CONFLICTING");
    expect(status?.checksStatus).toBe("failure");
  });

  it("returns null when no PR matches the current branch", async () => {
    const { service } = makeService(() => ok(JSON.stringify([OPEN_PR])));

    const status = await service.getCurrentPullRequestStatus({
      cwd: "/repo",
      headRef: "feat/nonexistent",
    });

    expect(status).toBeNull();
  });

  it("lists open pull requests", async () => {
    const { service, calls } = makeService(() => ok(JSON.stringify([OPEN_PR])));

    const prs = await service.listPullRequests({ cwd: "/repo" });

    expect(prs).toHaveLength(1);
    expect(prs[0]).toMatchObject({
      number: 5,
      title: "Add sample feature",
      baseRefName: "main",
      headRefName: "feat/sample-change",
      labels: ["enhancement", "review"],
      state: "open",
    });
    expect(calls[0]).toEqual(
      expect.arrayContaining(["pr", "list", "--state", "open", "-o", "json"]),
    );
  });

  it("lists issues", async () => {
    const { service, calls } = makeService(() => ok(JSON.stringify([OPEN_ISSUE])));

    const issues = await service.listIssues({ cwd: "/repo" });

    expect(issues[0]).toMatchObject({
      number: 3,
      title: "Login button misaligned",
      url: "https://gitea.com/example-user/sample-repo/issues/3",
      labels: ["bug"],
      state: "open",
    });
    expect(calls[0]).toEqual([
      "issue",
      "list",
      "--fields",
      "index,state,author,url,title,body,labels,comments,created,updated",
      "--state",
      "open",
      "-o",
      "json",
    ]);
  });

  it("fetches a single pull request by number", async () => {
    const { service } = makeService(() => ok(JSON.stringify([OPEN_PR, CONFLICTING_PR])));

    const pr = await service.getPullRequest({ cwd: "/repo", number: 6 });

    expect(pr.number).toBe(6);
    expect(pr.headRefName).toBe("feat/conflict");
  });

  it("creates a pull request and parses the resulting URL and index", async () => {
    const { service, calls } = makeService((args) => {
      if (args[0] === "pr" && args[1] === "create") {
        return ok("Created #7\nhttps://gitea.com/example-user/sample-repo/pulls/7");
      }
      throw new Error(`unexpected call: ${args.join(" ")}`);
    });

    const result = await service.createPullRequest({
      cwd: "/repo",
      repo: "example-user/sample-repo",
      title: "New feature",
      head: "feat/new",
      base: "main",
      body: "Body",
    });

    expect(result).toEqual({
      url: "https://gitea.com/example-user/sample-repo/pulls/7",
      number: 7,
    });
    expect(calls[0]).toEqual(
      expect.arrayContaining(["pr", "create", "--head", "feat/new", "--base", "main"]),
    );
  });

  it("merges a mergeable pull request with the requested style", async () => {
    const { service, calls } = makeService(() => ok(""));

    const result = await service.mergePullRequest({
      cwd: "/repo",
      prNumber: 5,
      mergeMethod: "squash",
      status: giteaMergeStatus(),
    });

    expect(result).toEqual({ success: true });
    expect(calls[0]).toEqual(["pr", "merge", "5", "--style", "squash"]);
  });

  it("refuses to merge a pull request Gitea does not report as mergeable", async () => {
    const { service, calls } = makeService(() => ok(""));

    await expect(
      service.mergePullRequest({
        cwd: "/repo",
        prNumber: 6,
        mergeMethod: "merge",
        status: giteaMergeStatus({
          forgeSpecific: {
            forge: "gitea",
            mergeable: false,
            hasMerged: false,
            ciStatus: "failure",
          },
        }),
      }),
    ).rejects.toThrow(/ready for direct merge/);
    expect(calls).toHaveLength(0);
  });

  it("maps Gitea PR comments and reviews to a neutral timeline", async () => {
    const { service, calls } = makeService((args) => {
      if (args[0] === "pr" && args[1] === "1") return ok(JSON.stringify(TIMELINE_PR_VIEW));
      if (args[0] === "api" && args[1].includes("/issues/1/comments"))
        return ok(JSON.stringify(TIMELINE_ISSUE_COMMENTS));
      if (args[0] === "api" && args[1].includes("/pulls/1/reviews?"))
        return ok(JSON.stringify(TIMELINE_REVIEWS));
      if (args[0] === "api" && args[1].includes("/reviews/2002/comments"))
        return ok(JSON.stringify(TIMELINE_REVIEW_COMMENTS));
      throw new Error(`unexpected call: ${args.join(" ")}`);
    });

    const timeline = await service.getPullRequestTimeline({
      cwd: "/repo",
      prNumber: 1,
      repoOwner: "example-user",
      repoName: "sample-repo",
    });

    expect(calls).toEqual([
      ["pr", "1", "-o", "json"],
      [
        "api",
        "repos/example-user/sample-repo/issues/1/comments?page=1&limit=100",
      ],
      [
        "api",
        "repos/example-user/sample-repo/pulls/1/reviews?page=1&limit=100",
      ],
      [
        "api",
        "repos/example-user/sample-repo/pulls/1/reviews/2002/comments?page=1&limit=100",
      ],
    ]);
    expect(timeline.error).toBeNull();
    expect(timeline.truncated).toBe(false);
    expect(timeline.items.map((item) => item.id)).toEqual([
      "1001",
      "2001",
      "1003",
      "2002",
    ]);
    expect(timeline.items[0]).toMatchObject({
      kind: "comment",
      author: "example-user",
      authorUrl: "https://gitea.com/example-user",
      avatarUrl:
        "https://gitea.com/avatars/0000000000000000000000000000000000000000000000000000000000000000",
      body: "Timeline fixture issue comment from tea api.",
      createdAt: Date.parse("2026-06-28T16:15:18Z"),
      url: "https://gitea.com/example-user/sample-repo/pulls/1#issuecomment-1001",
    });
    expect(timeline.items[1]).toMatchObject({
      kind: "review",
      id: "2001",
      reviewState: "commented",
      body: "Timeline fixture general review comment.",
    });
    expect(timeline.items[2]).toMatchObject({
      kind: "comment",
      id: "1003",
      reviewId: "2002",
      location: { path: "README.md", line: 4, threadId: "2002" },
    });
  });

  it("keeps issue comments when the Gitea reviews endpoint fails", async () => {
    const { service, calls } = makeService((args) => {
      if (args[0] === "pr" && args[1] === "1") return ok(JSON.stringify(TIMELINE_PR_VIEW));
      if (args[0] === "api" && args[1].includes("/issues/1/comments"))
        return ok(JSON.stringify(TIMELINE_ISSUE_COMMENTS));
      if (args[0] === "api" && args[1].includes("/pulls/1/reviews?"))
        throw { code: 1, stderr: "404 reviews endpoint not found" };
      throw new Error(`unexpected call: ${args.join(" ")}`);
    });

    const timeline = await service.getPullRequestTimeline({
      cwd: "/repo",
      prNumber: 1,
      repoOwner: "example-user",
      repoName: "sample-repo",
    });

    expect(calls).toHaveLength(3);
    expect(timeline).toMatchObject({
      error: null,
      truncated: false,
      items: [
        {
          kind: "comment",
          id: "1001",
          body: "Timeline fixture issue comment from tea api.",
        },
      ],
    });
  });

  it("keeps review summaries and other comments when one inline review comment fetch fails", async () => {
    const reviews = TIMELINE_REVIEWS.map((review) => ({ ...review, comments_count: 1 }));
    const { service, calls } = makeService((args) => {
      if (args[0] === "pr" && args[1] === "1") return ok(JSON.stringify(TIMELINE_PR_VIEW));
      if (args[0] === "api" && args[1].includes("/issues/1/comments"))
        return ok(JSON.stringify(TIMELINE_ISSUE_COMMENTS));
      if (args[0] === "api" && args[1].includes("/pulls/1/reviews?"))
        return ok(JSON.stringify(reviews));
      if (args[0] === "api" && args[1].includes("/reviews/2001/comments"))
        throw { code: 1, stderr: "500 failed to fetch inline comments" };
      if (args[0] === "api" && args[1].includes("/reviews/2002/comments"))
        return ok(JSON.stringify(TIMELINE_REVIEW_COMMENTS));
      throw new Error(`unexpected call: ${args.join(" ")}`);
    });

    const timeline = await service.getPullRequestTimeline({
      cwd: "/repo",
      prNumber: 1,
      repoOwner: "example-user",
      repoName: "sample-repo",
    });

    expect(calls).toHaveLength(5);
    expect(timeline.error).toBeNull();
    expect(timeline.items.map((item) => item.id)).toEqual([
      "1001",
      "2001",
      "1003",
      "2002",
    ]);
    expect(timeline.items).toContainEqual(
      expect.objectContaining({
        kind: "comment",
        id: "1003",
        reviewId: "2002",
      }),
    );
  });

  it("maps Gitea review verdict states", async () => {
    const reviews = [
      { ...TIMELINE_REVIEWS[0], id: 1, state: "APPROVED", body: "approved", comments_count: 0 },
      {
        ...TIMELINE_REVIEWS[1],
        id: 2,
        state: "REQUEST_CHANGES",
        body: "needs work",
        comments_count: 0,
      },
    ];
    const { service } = makeService((args) => {
      if (args[0] === "pr") return ok(JSON.stringify(TIMELINE_PR_VIEW));
      if (args[0] === "api" && args[1].includes("/issues/1/comments")) return ok("[]");
      if (args[0] === "api" && args[1].includes("/pulls/1/reviews?"))
        return ok(JSON.stringify(reviews));
      throw new Error(`unexpected call: ${args.join(" ")}`);
    });

    const timeline = await service.getPullRequestTimeline({
      cwd: "/repo",
      prNumber: 1,
      repoOwner: "example-user",
      repoName: "sample-repo",
    });

    expect(timeline.items).toMatchObject([
      { kind: "review", id: "1", reviewState: "approved" },
      { kind: "review", id: "2", reviewState: "changes_requested" },
    ]);
  });

  it("drops Gitea system comments from the neutral timeline", async () => {
    const { service } = makeService((args) => {
      if (args[0] === "pr") return ok(JSON.stringify(TIMELINE_PR_VIEW));
      if (args[0] === "api" && args[1].includes("/issues/1/comments"))
        return ok(JSON.stringify([{ ...TIMELINE_ISSUE_COMMENTS[0], type: "pull_ref" }]));
      if (args[0] === "api" && args[1].includes("/pulls/1/reviews?")) return ok("[]");
      throw new Error(`unexpected call: ${args.join(" ")}`);
    });

    const timeline = await service.getPullRequestTimeline({
      cwd: "/repo",
      prNumber: 1,
      repoOwner: "example-user",
      repoName: "sample-repo",
    });

    expect(timeline.items).toEqual([]);
  });

  it.each([
    ["404 pull request not found", "not_found"],
    ["403 Forbidden", "forbidden"],
    ["401 Unauthorized", "forbidden"],
  ] as const)("returns a neutral %s timeline error", async (stderr, kind) => {
    const { service } = makeService(() => {
      throw { code: 1, stderr };
    });

    const timeline = await service.getPullRequestTimeline({
      cwd: "/repo",
      prNumber: 99,
      repoOwner: "example-user",
      repoName: "sample-repo",
    });

    expect(timeline).toMatchObject({
      prNumber: 99,
      repoOwner: "example-user",
      repoName: "sample-repo",
      items: [],
      truncated: false,
      error: { kind },
    });
  });

  it("flags a full Gitea comments page as truncated", async () => {
    const comments = Array.from({ length: 100 }, (_, index) => ({
      ...TIMELINE_ISSUE_COMMENTS[0],
      id: 2000 + index,
    }));
    const { service } = makeService((args) => {
      if (args[0] === "pr") return ok(JSON.stringify(TIMELINE_PR_VIEW));
      if (args[0] === "api" && args[1].includes("/issues/1/comments"))
        return ok(JSON.stringify(comments));
      if (args[0] === "api" && args[1].includes("/pulls/1/reviews?")) return ok("[]");
      throw new Error(`unexpected call: ${args.join(" ")}`);
    });

    const timeline = await service.getPullRequestTimeline({
      cwd: "/repo",
      prNumber: 1,
      repoOwner: "example-user",
      repoName: "sample-repo",
    });

    expect(timeline).toMatchObject({
      truncated: true,
      error: null,
    });
  });

  it("reports authenticated when a tea login matches the remote host", async () => {
    const { service } = makeService((args) => {
      if (args[0] === "login" && args[1] === "list") return ok(JSON.stringify(LOGINS));
      throw new Error(`unexpected call: ${args.join(" ")}`);
    });

    await expect(service.isAuthenticated({ cwd: "/repo" })).resolves.toBe(true);
  });

  it("reports unauthenticated when no tea login matches the remote host", async () => {
    const { service } = makeService(
      (args) => {
        if (args[0] === "login" && args[1] === "list") return ok(JSON.stringify(LOGINS));
        throw new Error(`unexpected call: ${args.join(" ")}`);
      },
      { resolveRemoteUrl: async () => "https://git.other.example/team/repo.git" },
    );

    await expect(service.isAuthenticated({ cwd: "/repo" })).resolves.toBe(false);
  });

  it("maps an authentication failure from tea onto TeaAuthenticationError", async () => {
    const { service } = makeService(() => {
      throw { code: 1, stderr: "401 Unauthorized" };
    });

    await expect(service.listPullRequests({ cwd: "/repo" })).rejects.toBeInstanceOf(
      TeaAuthenticationError,
    );
  });

  it("searches issues and pull requests and maps them to neutral results", async () => {
    const { service, calls } = makeService((args) => {
      if (args[0] === "issue") return ok(JSON.stringify([OPEN_ISSUE]));
      if (args[0] === "pr") return ok(JSON.stringify([OPEN_PR]));
      throw new Error(`unexpected tea args: ${args.join(" ")}`);
    });

    const result = await service.searchIssuesAndPrs({ cwd: "/repo", query: "", limit: 10 });

    expect(result.githubFeaturesEnabled).toBe(true);
    expect(result.items).toEqual([
      {
        kind: "pr",
        number: 5,
        title: "Add sample feature",
        url: "https://gitea.com/example-user/sample-repo/pulls/5",
        state: "open",
        body: "Implements the sample feature",
        labels: ["enhancement", "review"],
        baseRefName: "main",
        headRefName: "feat/sample-change",
        updatedAt: "2026-06-26T10:00:00Z",
      },
      {
        kind: "issue",
        number: 3,
        title: "Login button misaligned",
        url: "https://gitea.com/example-user/sample-repo/issues/3",
        state: "open",
        body: "On mobile the button overflows",
        labels: ["bug"],
        baseRefName: null,
        headRefName: null,
        updatedAt: "2026-06-24T09:00:00Z",
      },
    ]);

    expect(calls.find((args) => args[0] === "issue")).toEqual([
      "issue",
      "list",
      "--fields",
      "index,state,author,url,title,body,labels,comments,created,updated",
      "--state",
      "open",
      "-o",
      "json",
      "--limit",
      "10",
    ]);
    expect(calls.find((args) => args[0] === "pr")).toEqual([
      "pr",
      "list",
      "--fields",
      "index,state,author,url,title,body,mergeable,base,head,created,updated,labels,comments,ci",
      "--state",
      "open",
      "-o",
      "json",
      "--limit",
      "10",
    ]);
  });

  it("sorts issue and pull request search results by update time", async () => {
    const { service } = makeService((args) => {
      if (args[0] === "issue") return ok(JSON.stringify([OPEN_ISSUE]));
      if (args[0] === "pr") return ok(JSON.stringify([OPEN_PR]));
      throw new Error(`unexpected tea args: ${args.join(" ")}`);
    });

    const result = await service.searchIssuesAndPrs({ cwd: "/repo", query: "" });

    expect(result).toEqual({
      githubFeaturesEnabled: true,
      items: [
        {
          kind: "pr",
          number: 5,
          title: "Add sample feature",
          url: "https://gitea.com/example-user/sample-repo/pulls/5",
          state: "open",
          body: "Implements the sample feature",
          labels: ["enhancement", "review"],
          baseRefName: "main",
          headRefName: "feat/sample-change",
          updatedAt: "2026-06-26T10:00:00Z",
        },
        {
          kind: "issue",
          number: 3,
          title: "Login button misaligned",
          url: "https://gitea.com/example-user/sample-repo/issues/3",
          state: "open",
          body: "On mobile the button overflows",
          labels: ["bug"],
          baseRefName: null,
          headRefName: null,
          updatedAt: "2026-06-24T09:00:00Z",
        },
      ],
    });
  });

  it("restricts search to pull requests when only the PR kind is requested", async () => {
    const { service, calls } = makeService((args) => {
      if (args[0] === "pr") return ok(JSON.stringify([OPEN_PR]));
      throw new Error(`unexpected tea args: ${args.join(" ")}`);
    });

    const result = await service.searchIssuesAndPrs({
      cwd: "/repo",
      query: "sample",
      kinds: ["github-pr"],
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ kind: "pr", number: 5 });
    expect(calls).toEqual([
      [
        "pr",
        "list",
        "--fields",
        "index,state,author,url,title,body,mergeable,base,head,created,updated,labels,comments,ci",
        "--state",
        "open",
        "-o",
        "json",
      ],
    ]);
  });

  it("reports forge features disabled when tea is unavailable or unauthenticated", async () => {
    const missing = makeService(() => ok("[]"), { resolveTeaPath: async () => null }).service;
    await expect(missing.searchIssuesAndPrs({ cwd: "/repo", query: "x" })).resolves.toEqual({
      items: [],
      githubFeaturesEnabled: false,
    });

    const unauthenticated = makeService(() => {
      throw { code: 1, stderr: "401 Unauthorized" };
    }).service;
    await expect(unauthenticated.searchIssuesAndPrs({ cwd: "/repo", query: "x" })).resolves.toEqual(
      {
        items: [],
        githubFeaturesEnabled: false,
      },
    );
  });

  it("keeps forge features enabled when one search request fails for a non-auth reason", async () => {
    const { service } = makeService((args) => {
      if (args[0] === "issue") {
        throw { code: 1, stderr: "temporary Gitea API failure" };
      }
      return ok(JSON.stringify([OPEN_PR]));
    });

    await expect(service.searchIssuesAndPrs({ cwd: "/repo", query: "sample" })).resolves.toEqual({
      items: [
        {
          kind: "pr",
          number: 5,
          title: "Add sample feature",
          url: "https://gitea.com/example-user/sample-repo/pulls/5",
          state: "open",
          body: "Implements the sample feature",
          labels: ["enhancement", "review"],
          baseRefName: "main",
          headRefName: "feat/sample-change",
          updatedAt: "2026-06-26T10:00:00Z",
        },
      ],
      githubFeaturesEnabled: true,
    });
  });
});
