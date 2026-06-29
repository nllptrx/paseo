import type { ForgeSearchKind } from "@getpaseo/protocol/messages";

export function normalizeForgeSearchKinds(
  kinds: readonly (ForgeSearchKind | "github-issue" | "github-pr" | "pr")[] | undefined,
): ForgeSearchKind[] {
  if (!kinds) return ["issue", "change_request"];

  return kinds.map((kind) => {
    if (kind === "github-issue") return "issue";
    if (kind === "github-pr" || kind === "pr") return "change_request";
    return kind;
  });
}

export interface PullRequestSummary {
  number: number;
  title: string;
  url: string;
  state: string;
  body: string | null;
  projectPath?: string;
  baseRefName: string;
  headRefName: string;
  labels: string[];
  updatedAt: string;
}

export interface PullRequestCheckoutTarget {
  number: number;
  baseRefName: string;
  headRefName: string;
  checkoutRefs?: PullRequestCheckoutRef[];
  headOwnerLogin: string | null;
  headRepositorySshUrl: string | null;
  headRepositoryUrl: string | null;
  isCrossRepository: boolean;
}

export interface PullRequestCheckoutRef {
  remoteName?: string;
  remoteRef: string;
}

export interface IssueSummary {
  number: number;
  title: string;
  url: string;
  state: string;
  body: string | null;
  projectPath?: string;
  labels: string[];
  updatedAt: string;
}

export type PullRequestCheckStatus = "pending" | "success" | "failure" | "cancelled" | "skipped";

export interface PullRequestCheck {
  name: string;
  status: PullRequestCheckStatus;
  url: string | null;
  workflow?: string;
  duration?: string;
  checkRunId?: number;
  workflowRunId?: number;
}

export type PullRequestChecksStatus = "none" | "pending" | "success" | "failure";
export type PullRequestReviewDecision = "approved" | "changes_requested" | "pending" | null;
export type PullRequestMergeable = "MERGEABLE" | "CONFLICTING" | "UNKNOWN";

/**
 * Why a forge's PR/MR features are (un)available for a workspace. Replaces the
 * lossy "authenticated yes/no" boolean so the UI can offer the precise next step
 * (install the CLI vs sign in) instead of a single generic dead-end. "no_remote"
 * covers anything where the feature simply does not apply (no resolvable forge
 * remote, or no branch to look up). "error" is reserved for non-auth failures
 * where the UI should show the actual error instead of setup guidance.
 */
export type ForgeAuthState =
  | "authenticated"
  | "unauthenticated"
  | "cli_missing"
  | "no_remote"
  | "error";

export interface GitHubPullRequestStatusFacts {
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
}

/**
 * GitLab merge facts as reported by `glab mr view -F json`. The home for the
 * gitlab arm of {@link ForgeSpecificStatusFacts}; mirrors the GitHub adapter's
 * {@link GitHubPullRequestStatusFacts}.
 */
export interface GitLabStatusFacts {
  detailedMergeStatus: string | null;
  hasConflicts: boolean;
  blockingDiscussionsResolved: boolean;
  approvalsRequired: number;
  approvalsGiven: number;
  pipelineStatus: string | null;
  /**
   * Id of the MR's head pipeline, used to fetch the full pipeline (stages →
   * jobs) on demand. Null when the MR has no pipeline yet.
   */
  pipelineId: number | null;
  pipelineUrl: string | null;
  mergeWhenPipelineSucceeds: boolean;
}

/**
 * Gitea merge facts as reported by `tea pr list -o json`. Gitea models CI as a
 * single aggregate status string rather than a pipeline tree.
 */
export interface GiteaStatusFacts {
  mergeable: boolean;
  hasMerged: boolean;
  ciStatus: string | null;
}

/**
 * Discriminated home for a forge's native merge facts on the neutral PR status.
 * Each adapter populates its own arm; readers narrow on `forge` to reach the
 * facts a given forge actually reports.
 */
export type ForgeSpecificStatusFacts =
  | ({ forge: "github" } & GitHubPullRequestStatusFacts)
  | ({ forge: "gitlab" } & GitLabStatusFacts)
  | ({ forge: "gitea" } & GiteaStatusFacts);

export function isGiteaStatusFacts(
  facts: ForgeSpecificStatusFacts | null | undefined,
): facts is { forge: "gitea" } & GiteaStatusFacts {
  return facts?.forge === "gitea";
}

export interface CurrentPullRequestStatus {
  number?: number;
  repoOwner?: string;
  repoName?: string;
  /**
   * The forge's full project path (e.g. nested GitLab namespaces like
   * `group/subgroup/repo`). Adapters that can report it precisely set it here;
   * otherwise consumers fall back to deriving it from owner/name.
   */
  projectPath?: string;
  url: string;
  title: string;
  state: string;
  baseRefName: string;
  headRefName: string;
  isMerged: boolean;
  isDraft?: boolean;
  mergeable: PullRequestMergeable;
  checks: PullRequestCheck[];
  checksStatus: PullRequestChecksStatus;
  reviewDecision: PullRequestReviewDecision;
  forgeSpecific?: ForgeSpecificStatusFacts;
}

export type PullRequestTimelineReviewState = "approved" | "changes_requested" | "commented";

interface PullRequestTimelineItemBase {
  id: string;
  author: string;
  authorUrl: string | null;
  avatarUrl: string | null;
  body: string;
  createdAt: number;
  url: string;
}

export type PullRequestTimelineItem =
  | (PullRequestTimelineItemBase & {
      kind: "review";
      reviewState: PullRequestTimelineReviewState;
    })
  | (PullRequestTimelineItemBase & {
      kind: "comment";
      reviewId?: string;
      threadId?: string;
      location?: PullRequestTimelineCommentLocation;
    });

export interface PullRequestTimelineCommentLocation {
  path: string;
  line?: number;
  startLine?: number;
  threadId?: string;
  isResolved?: boolean;
  isOutdated?: boolean;
}

export type PullRequestTimelineErrorKind = "not_found" | "forbidden" | "unknown";

export interface PullRequestTimelineError {
  kind: PullRequestTimelineErrorKind;
  message: string;
}

export interface PullRequestTimeline {
  prNumber: number;
  repoOwner: string;
  repoName: string;
  items: PullRequestTimelineItem[];
  truncated: boolean;
  error: PullRequestTimelineError | null;
}

export interface PullRequestCreateResult {
  url: string;
  number: number;
}

export type PullRequestMergeMethod = "merge" | "squash" | "rebase";

export interface PullRequestCommandStatus {
  mergeable?: PullRequestMergeable;
  forgeSpecific?: ForgeSpecificStatusFacts;
}

export interface MergePullRequestOptions {
  cwd: string;
  prNumber: number;
  mergeMethod: PullRequestMergeMethod;
  status?: PullRequestCommandStatus | null;
}

export interface EnablePullRequestAutoMergeOptions {
  cwd: string;
  prNumber: number;
  mergeMethod: PullRequestMergeMethod;
  status?: PullRequestCommandStatus | null;
}

export interface DisablePullRequestAutoMergeOptions {
  cwd: string;
  prNumber: number;
  status?: PullRequestCommandStatus | null;
}

export interface PullRequestMergeResult {
  success: true;
}

export interface PullRequestAutoMergeResult {
  success: true;
}

export type ForgeReadOptions =
  | {
      force?: false;
      reason?: string;
    }
  | {
      force: true;
      reason: string;
    };

export type ListPullRequestsOptions = {
  cwd: string;
  query?: string;
  limit?: number;
} & ForgeReadOptions;

export type ListIssuesOptions = {
  cwd: string;
  query?: string;
  limit?: number;
} & ForgeReadOptions;

export type GetPullRequestOptions = {
  cwd: string;
  number: number;
} & ForgeReadOptions;

export type GetPullRequestTimelineOptions = {
  cwd: string;
  prNumber: number;
  repoOwner: string;
  repoName: string;
} & ForgeReadOptions;

export type GetCheckDetailsOptions = {
  cwd: string;
  /**
   * GitHub-only: the GitHub adapter addresses the check run by owner/name. The
   * GitLab adapter resolves the project from the cwd's remote and ignores these.
   */
  repoOwner?: string;
  repoName?: string;
  checkRunId: number;
  workflowRunId?: number;
} & ForgeReadOptions;

export interface CheckAnnotation {
  path?: string;
  startLine?: number;
  endLine?: number;
  annotationLevel?: string;
  message?: string;
  title?: string;
  rawDetails?: string;
}

export interface CheckFailedJob {
  jobId: number;
  name: string;
  status?: string | null;
  conclusion?: string | null;
  url?: string | null;
  completedAt?: string;
  logTail?: string;
  logTruncated?: boolean;
}

/**
 * Normalized lifecycle of a CI job/pipeline, neutral across forges. Adapters
 * map their forge's raw status strings onto this; readers keep the raw string
 * too (see {@link PipelineJob.rawStatus}) for display fidelity.
 */
export type PipelineJobStatus =
  | "success"
  | "failed"
  | "running"
  | "pending"
  | "canceled"
  | "skipped"
  | "manual"
  | "created"
  | "unknown";

export interface PipelineJob {
  id: number;
  name: string;
  stage: string;
  status: PipelineJobStatus;
  rawStatus: string;
  url: string | null;
  allowFailure: boolean;
  durationSeconds: number | null;
}

export interface PipelineStage {
  name: string;
  status: PipelineJobStatus;
  jobs: PipelineJob[];
}

/**
 * A CI pipeline as a stage → job tree. Forges that model CI as a pipeline
 * (GitLab) populate this; forges that model it as flat check runs (GitHub)
 * leave {@link CheckDetails.pipeline} undefined and use the check-run fields.
 */
export interface PipelineDetails {
  id: number;
  status: PipelineJobStatus;
  rawStatus: string;
  url: string | null;
  ref: string | null;
  sha: string | null;
  stages: PipelineStage[];
}

export interface CheckDetails {
  checkRunId: number;
  workflowRunId?: number | null;
  name: string;
  status?: string | null;
  conclusion?: string | null;
  url?: string | null;
  detailsUrl?: string | null;
  output?: {
    title?: string | null;
    summary?: string | null;
    text?: string | null;
  } | null;
  annotations: CheckAnnotation[];
  failedJobs: CheckFailedJob[];
  truncated: boolean;
  /**
   * Structured pipeline (stages → jobs) for forges that model CI as a pipeline.
   * GitLab populates it; GitHub leaves it undefined and keeps using the flat
   * check-run fields above.
   */
  pipeline?: PipelineDetails | null;
}

export interface SearchResult {
  items: Array<{
    kind: "issue" | "pr";
    forge?: string;
    number: number;
    title: string;
    url: string;
    state: string;
    body: string | null;
    labels: string[];
    projectPath?: string;
    baseRefName?: string | null;
    headRefName?: string | null;
    updatedAt?: string;
  }>;
  featuresEnabled: boolean;
  authState: ForgeAuthState;
  /**
   * COMPAT(githubFeaturesEnabled): added in v0.1.102, remove after 2026-12-28.
   * TODO(before merge): align the added version and removal date with the maintainer's target release.
   */
  githubFeaturesEnabled?: boolean;
}

export function createUnavailableSearchResult(
  authState: Exclude<ForgeAuthState, "authenticated">,
): SearchResult {
  return {
    items: [],
    featuresEnabled: false,
    authState,
    githubFeaturesEnabled: false,
  };
}

export type SearchIssuesAndPrsOptions = {
  cwd: string;
  query: string;
  limit?: number;
  kinds?: ForgeSearchKind[];
} & ForgeReadOptions;

export interface CreatePullRequestOptions {
  cwd: string;
  repo: string;
  title: string;
  head: string;
  base: string;
  body?: string;
}

export interface ForgeService {
  listPullRequests(options: ListPullRequestsOptions): Promise<PullRequestSummary[]>;
  listIssues(options: ListIssuesOptions): Promise<IssueSummary[]>;
  getPullRequest(options: GetPullRequestOptions): Promise<PullRequestSummary>;
  getPullRequestHeadRef(options: GetPullRequestOptions): Promise<string>;
  getPullRequestCheckoutTarget?(options: GetPullRequestOptions): Promise<PullRequestCheckoutTarget>;
  getCurrentPullRequestStatus(
    options: {
      cwd: string;
      headRef: string;
      headRepositoryOwner?: string;
    } & ForgeReadOptions,
  ): Promise<CurrentPullRequestStatus | null>;
  getPullRequestTimeline(options: GetPullRequestTimelineOptions): Promise<PullRequestTimeline>;
  getCheckDetails(options: GetCheckDetailsOptions): Promise<CheckDetails>;
  searchIssuesAndPrs(options: SearchIssuesAndPrsOptions): Promise<SearchResult>;
  createPullRequest(options: CreatePullRequestOptions): Promise<PullRequestCreateResult>;
  mergePullRequest(options: MergePullRequestOptions): Promise<PullRequestMergeResult>;
  enablePullRequestAutoMerge(
    options: EnablePullRequestAutoMergeOptions,
  ): Promise<PullRequestAutoMergeResult>;
  disablePullRequestAutoMerge(
    options: DisablePullRequestAutoMergeOptions,
  ): Promise<PullRequestAutoMergeResult>;
  isAuthenticated(options: { cwd: string } & ForgeReadOptions): Promise<boolean>;
  retainCurrentPullRequestStatusPoll?(options: {
    cwd: string;
    headRef: string;
    headRepositoryOwner?: string;
    onStatus?: (status: CurrentPullRequestStatus | null) => void;
    onError?: (error: unknown) => void;
  }): { unsubscribe: () => void };
  invalidate(options: { cwd: string }): void;
  dispose?(): void;
}
