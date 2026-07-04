import { describe, expect, it } from "vitest";

import { deriveMergeCapability, type ForgeSpecificStatusFacts } from "./merge-capability";

type GithubMergeFactsFixture = ForgeSpecificStatusFacts & {
  forge: "github";
  mergeStateStatus: string | null;
  autoMergeRequest: {
    enabledAt: string | null;
    mergeMethod: string | null;
    enabledBy: string | null;
  } | null;
  viewerCanEnableAutoMerge: boolean;
  viewerCanDisableAutoMerge: boolean;
  viewerCanMergeAsAdmin: boolean;
  viewerCanUpdateBranch: boolean;
  repository: {
    autoMergeAllowed: boolean;
    mergeCommitAllowed: boolean;
    squashMergeAllowed: boolean;
    rebaseMergeAllowed: boolean;
    viewerDefaultMergeMethod: string | null;
  };
  isMergeQueueEnabled: boolean;
  isInMergeQueue: boolean;
};

function facts(overrides: Partial<GithubMergeFactsFixture> = {}): GithubMergeFactsFixture {
  return {
    forge: "github",
    mergeStateStatus: "CLEAN",
    autoMergeRequest: null,
    viewerCanEnableAutoMerge: false,
    viewerCanDisableAutoMerge: false,
    viewerCanMergeAsAdmin: false,
    viewerCanUpdateBranch: false,
    repository: {
      autoMergeAllowed: false,
      mergeCommitAllowed: true,
      squashMergeAllowed: true,
      rebaseMergeAllowed: true,
      viewerDefaultMergeMethod: "SQUASH",
    },
    isMergeQueueEnabled: false,
    isInMergeQueue: false,
    ...overrides,
  };
}

describe("deriveMergeCapability", () => {
  it("returns null when the forge supplied no merge facts", () => {
    expect(deriveMergeCapability(null)).toBeNull();
    expect(deriveMergeCapability(undefined)).toBeNull();
  });

  it("marks direct merge ready only for the GitHub clean states", () => {
    expect(deriveMergeCapability(facts({ mergeStateStatus: "CLEAN" }))?.directMergeReady).toBe(
      true,
    );
    expect(deriveMergeCapability(facts({ mergeStateStatus: "HAS_HOOKS" }))?.directMergeReady).toBe(
      true,
    );
    expect(deriveMergeCapability(facts({ mergeStateStatus: "BLOCKED" }))?.directMergeReady).toBe(
      false,
    );
    expect(deriveMergeCapability(facts({ mergeStateStatus: null }))?.directMergeReady).toBe(false);
  });

  it("can enable auto-merge only when blocked, allowed, and the viewer may enable it", () => {
    const ready = facts({
      mergeStateStatus: "BLOCKED",
      viewerCanEnableAutoMerge: true,
      repository: {
        autoMergeAllowed: true,
        mergeCommitAllowed: true,
        squashMergeAllowed: true,
        rebaseMergeAllowed: true,
        viewerDefaultMergeMethod: "SQUASH",
      },
    });
    expect(deriveMergeCapability(ready)?.canEnableAutoMerge).toBe(true);

    expect(
      deriveMergeCapability(facts({ ...ready, viewerCanEnableAutoMerge: false }))
        ?.canEnableAutoMerge,
    ).toBe(false);
    expect(
      deriveMergeCapability(facts({ ...ready, mergeStateStatus: "CLEAN" }))?.canEnableAutoMerge,
    ).toBe(false);
  });

  it("reports whether auto-merge is already enabled and can be disabled", () => {
    const cap = deriveMergeCapability(
      facts({
        autoMergeRequest: { enabledAt: "now", mergeMethod: "SQUASH", enabledBy: "octocat" },
        viewerCanDisableAutoMerge: true,
      }),
    );
    expect(cap?.autoMergeEnabled).toBe(true);
    expect(cap?.canDisableAutoMerge).toBe(true);
    expect(deriveMergeCapability(facts())?.autoMergeEnabled).toBe(false);
  });

  it("treats an enabled or in-progress merge queue as blocking", () => {
    expect(deriveMergeCapability(facts({ isMergeQueueEnabled: true }))?.mergeBlockedByQueue).toBe(
      true,
    );
    expect(deriveMergeCapability(facts({ isInMergeQueue: true }))?.mergeBlockedByQueue).toBe(true);
    expect(deriveMergeCapability(facts())?.mergeBlockedByQueue).toBe(false);
  });

  it("derives allowed methods and the preferred method from the repository policy", () => {
    const cap = deriveMergeCapability(
      facts({
        repository: {
          autoMergeAllowed: false,
          mergeCommitAllowed: false,
          squashMergeAllowed: true,
          rebaseMergeAllowed: true,
          viewerDefaultMergeMethod: "REBASE",
        },
      }),
    );
    expect(cap?.allowedMethods).toEqual(["squash", "rebase"]);
    expect(cap?.preferredMethod).toBe("rebase");
  });

  it("returns a null preferred method when the forge reports an unknown default", () => {
    expect(
      deriveMergeCapability(
        facts({ repository: { ...facts().repository, viewerDefaultMergeMethod: null } }),
      )?.preferredMethod,
    ).toBeNull();
  });
});

describe("deriveMergeCapability (legacy github fallback)", () => {
  it("synthesizes full GitHub capability from legacy status.github when forgeSpecific is absent", () => {
    const { forge: _forge, ...legacy } = facts({
      mergeStateStatus: "CLEAN",
      repository: {
        autoMergeAllowed: false,
        mergeCommitAllowed: false,
        squashMergeAllowed: true,
        rebaseMergeAllowed: false,
        viewerDefaultMergeMethod: "SQUASH",
      },
    });
    const cap = deriveMergeCapability(undefined, legacy);
    expect(cap).not.toBeNull();
    expect(cap?.directMergeReady).toBe(true);
    expect(cap?.allowedMethods).toEqual(["squash"]);
    expect(cap?.preferredMethod).toBe("squash");
  });

  it("returns null when both forgeSpecific and legacy github facts are absent", () => {
    expect(deriveMergeCapability(undefined, null)).toBeNull();
    expect(deriveMergeCapability(undefined, undefined)).toBeNull();
  });
});
