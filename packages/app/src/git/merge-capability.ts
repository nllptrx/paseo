import type { CheckoutPrMergeMethod, CheckoutPrStatusResponse } from "@getpaseo/protocol/messages";

/**
 * The forge's native merge facts as they arrive over the wire on a PR status,
 * discriminated by `forge`. Each forge feeds its own arm into
 * {@link deriveMergeCapability}.
 */
export type ForgeSpecificStatusFacts = NonNullable<
  NonNullable<CheckoutPrStatusResponse["payload"]["status"]>["forgeSpecific"]
>;

/** GitHub merge facts — the `github` arm of {@link ForgeSpecificStatusFacts}. */
export type GithubMergeFacts = Extract<ForgeSpecificStatusFacts, { forge: "github" }>;

/** GitLab merge facts — the `gitlab` arm of {@link ForgeSpecificStatusFacts}. */
export type GitlabMergeFacts = Extract<ForgeSpecificStatusFacts, { forge: "gitlab" }>;

/** Gitea merge facts used by both the Gitea and Forgejo top-level forges. */
export type GiteaMergeFacts = Extract<ForgeSpecificStatusFacts, { forge: "gitea" }>;

function isGithubMergeFacts(facts: ForgeSpecificStatusFacts): facts is GithubMergeFacts {
  return facts.forge === "github" && "repository" in facts;
}

function isGitlabMergeFacts(facts: ForgeSpecificStatusFacts): facts is GitlabMergeFacts {
  return facts.forge === "gitlab" && "detailedMergeStatus" in facts;
}

function isGiteaMergeFacts(facts: ForgeSpecificStatusFacts): facts is GiteaMergeFacts {
  return facts.forge === "gitea" && "mergeable" in facts;
}

/**
 * Legacy GitHub merge facts from the pre-forgeSpecific `status.github` field. An
 * old daemon emits only this; a new client synthesizes the github arm from it so
 * GitHub merge-method restrictions and auto-merge state keep working.
 */
export type LegacyGithubMergeFacts = NonNullable<
  NonNullable<CheckoutPrStatusResponse["payload"]["status"]>["github"]
>;

/**
 * Forge-neutral view of which merge actions a change request supports right
 * now. The action policy reads only this shape, so it never depends on a
 * specific forge's native merge model (GitHub merge-state, GitLab
 * detailed-merge-status + pipeline).
 */
export interface MergeCapability {
  /** The change request can be merged directly right now. */
  directMergeReady: boolean;
  /** Auto-merge can be enabled right now. */
  canEnableAutoMerge: boolean;
  /** Auto-merge is already enabled on the change request. */
  autoMergeEnabled: boolean;
  /** The viewer is allowed to disable the active auto-merge. */
  canDisableAutoMerge: boolean;
  /** A merge queue is blocking both direct merge and auto-merge. */
  mergeBlockedByQueue: boolean;
  /** Merge methods the forge permits for this change request. */
  allowedMethods: CheckoutPrMergeMethod[];
  /** The forge's preferred/default merge method, if it reports one. */
  preferredMethod: CheckoutPrMergeMethod | null;
}

const GITHUB_DIRECT_MERGE_STATE_ALLOWLIST = new Set(["CLEAN", "HAS_HOOKS"]);

function normalizeGithubMergeMethod(value: string | null): CheckoutPrMergeMethod | null {
  if (value === "SQUASH") return "squash";
  if (value === "MERGE") return "merge";
  if (value === "REBASE") return "rebase";
  return null;
}

function deriveGithubMergeCapability(github: GithubMergeFacts): MergeCapability {
  const repository = github.repository;
  const allowedMethods: CheckoutPrMergeMethod[] = [];
  if (repository.mergeCommitAllowed) allowedMethods.push("merge");
  if (repository.squashMergeAllowed) allowedMethods.push("squash");
  if (repository.rebaseMergeAllowed) allowedMethods.push("rebase");
  return {
    directMergeReady: GITHUB_DIRECT_MERGE_STATE_ALLOWLIST.has(github.mergeStateStatus ?? ""),
    canEnableAutoMerge:
      github.mergeStateStatus === "BLOCKED" &&
      repository.autoMergeAllowed &&
      github.viewerCanEnableAutoMerge,
    autoMergeEnabled: github.autoMergeRequest !== null,
    canDisableAutoMerge: github.viewerCanDisableAutoMerge === true,
    mergeBlockedByQueue: github.isMergeQueueEnabled || github.isInMergeQueue,
    allowedMethods,
    preferredMethod: normalizeGithubMergeMethod(repository.viewerDefaultMergeMethod ?? null),
  };
}

// GitLab's `detailed_merge_status` collapses every precondition — approvals,
// discussions, pipeline, conflicts — into a single verdict; "mergeable" means
// all of them are satisfied. The individual GitLab facts are carried for the
// pipeline/approval surfaces to display; direct-merge readiness reads the verdict.
const GITLAB_MERGEABLE_STATUS = "mergeable";
const GITLAB_MERGE_METHODS: CheckoutPrMergeMethod[] = ["merge", "squash", "rebase"];

function deriveGitlabMergeCapability(gitlab: GitlabMergeFacts): MergeCapability {
  return {
    directMergeReady: gitlab.detailedMergeStatus === GITLAB_MERGEABLE_STATUS,
    // Auto-merge (merge-when-pipeline-succeeds) enable/disable is a separate
    // GitLab surface; this foundation only reflects whether it is already on.
    canEnableAutoMerge: false,
    autoMergeEnabled: gitlab.mergeWhenPipelineSucceeds === true,
    canDisableAutoMerge: false,
    mergeBlockedByQueue: false,
    allowedMethods: GITLAB_MERGE_METHODS,
    preferredMethod: null,
  };
}

const GITEA_MERGE_METHODS: CheckoutPrMergeMethod[] = ["merge", "squash", "rebase"];

function deriveGiteaMergeCapability(gitea: GiteaMergeFacts): MergeCapability {
  return {
    directMergeReady: gitea.mergeable && !gitea.hasMerged,
    canEnableAutoMerge: false,
    autoMergeEnabled: false,
    canDisableAutoMerge: false,
    mergeBlockedByQueue: false,
    allowedMethods: GITEA_MERGE_METHODS,
    preferredMethod: null,
  };
}

/**
 * Build the neutral merge capability from a forge's PR status facts. Returns
 * null when the forge supplied no merge facts (e.g. a host that exposes none, or
 * an unknown forge), in which case the caller falls back to raw git state.
 *
 * Back-compat: a daemon predating forgeSpecific emits only the legacy
 * `status.github` field. When forgeSpecific is absent we synthesize the github
 * arm from those legacy facts so GitHub merge-method restrictions and auto-merge
 * state are not lost against an old daemon — the protocol contract is sacred.
 */
export function deriveMergeCapability(
  forgeSpecific: ForgeSpecificStatusFacts | null | undefined,
  legacyGithubFacts?: LegacyGithubMergeFacts | null,
): MergeCapability | null {
  if (forgeSpecific === null || forgeSpecific === undefined) {
    if (legacyGithubFacts) {
      return deriveGithubMergeCapability({ forge: "github", ...legacyGithubFacts });
    }
    return null;
  }
  if (isGithubMergeFacts(forgeSpecific)) {
    return deriveGithubMergeCapability(forgeSpecific);
  }
  if (isGitlabMergeFacts(forgeSpecific)) {
    return deriveGitlabMergeCapability(forgeSpecific);
  }
  if (isGiteaMergeFacts(forgeSpecific)) {
    return deriveGiteaMergeCapability(forgeSpecific);
  }
  return null;
}
