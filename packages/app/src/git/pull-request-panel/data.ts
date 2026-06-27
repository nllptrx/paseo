import type {
  CheckoutPrStatusResponse,
  PullRequestTimelineResponse,
} from "@getpaseo/protocol/messages";
import type { Forge } from "@/git/forge";

export type PrState = "open" | "draft" | "merged" | "closed";
export type CheckStatus = "success" | "failure" | "pending" | "skipped";
export type ReviewState = "approved" | "changes_requested" | "commented";
export type ActivityKind = "review" | "comment";
export type PullRequestProvider = "github";

export interface PullRequestProviderMetadata {
  id: PullRequestProvider;
  label: string;
  url?: string | null;
}

const GITHUB_PROVIDER: PullRequestProviderMetadata = { id: "github", label: "GitHub" };

export interface PrPaneCheck {
  provider: PullRequestProvider;
  name: string;
  workflow?: string;
  status: CheckStatus;
  duration?: string;
  url: string;
  github?: {
    checkRunId?: number;
    workflowRunId?: number;
  };
}

export interface PrPaneActivity {
  provider: PullRequestProvider;
  id: string;
  kind: ActivityKind;
  author: string;
  authorUrl?: string | null;
  avatarColor: string;
  avatarUrl?: string | null;
  reviewState?: ReviewState;
  body: string;
  age: string;
  url: string;
  /** For inline review comments: the review this comment was submitted with. */
  reviewId?: string;
  location?: {
    path: string;
    line?: number;
    startLine?: number;
    threadId?: string;
    isResolved?: boolean;
    isOutdated?: boolean;
  };
}

/**
 * Summary of a GitLab MR's head pipeline. The full stage → job tree is fetched
 * lazily when the pipeline section is opened.
 */
export interface GitlabPipelineSummary {
  id: number;
  status: CheckStatus;
  rawStatus: string;
  url: string | null;
}

export interface PrPaneData {
  provider: PullRequestProviderMetadata;
  /**
   * The forge hosting this change request, driving the PR↔MR relabel, the
   * number prefix, and the brand mark. Distinct from {@link provider}, which
   * still tags the source of checks/timeline items (GitHub-only for now).
   */
  forge: Forge;
  number: number;
  repoOwner?: string;
  repoName?: string;
  /** Neutral project identity (GitLab namespaces nest beyond owner/name). */
  projectPath?: string;
  title: string;
  state: PrState;
  url: string;
  reviewDecision: "approved" | "changes_requested" | "pending";
  awaitingReviewers: string[];
  checks: PrPaneCheck[];
  /** Present only for GitLab MRs with a head pipeline. */
  gitlabPipeline?: GitlabPipelineSummary;
  activity: PrPaneActivity[];
}

type CheckoutPrStatus = CheckoutPrStatusResponse["payload"]["status"];
type PullRequestTimeline = PullRequestTimelineResponse["payload"];
type PullRequestTimelineItem = PullRequestTimeline["items"][number];

const AVATAR_COLORS = [
  "#8b5cf6",
  "#f97316",
  "#0ea5e9",
  "#10b981",
  "#ef4444",
  "#eab308",
  "#ec4899",
  "#6366f1",
];

export function mapPrPaneData(
  status: CheckoutPrStatus,
  timeline: PullRequestTimeline | null | undefined,
  nowMs = Date.now(),
  forge: Forge = "github",
): PrPaneData | null {
  if (!status) {
    return null;
  }

  const number = status.number ?? parsePullRequestNumber(status.url);
  if (number === null) {
    return null;
  }

  const timelineMatchesStatus = timeline?.prNumber === number;
  const gitlabPipeline = mapGitlabPipelineSummary(status);

  return {
    provider: GITHUB_PROVIDER,
    forge,
    number,
    repoOwner: status.repoOwner,
    repoName: status.repoName,
    projectPath: status.projectPath,
    title: status.title,
    state: derivePrState(status),
    url: status.url,
    reviewDecision: mapReviewDecision(status.reviewDecision),
    // Requested reviewers are intentionally unwired until the server exposes them.
    awaitingReviewers: [],
    checks: (status.checks ?? []).flatMap(mapCheck),
    ...(gitlabPipeline ? { gitlabPipeline } : {}),
    activity: timelineMatchesStatus
      ? timeline.items.flatMap((item) => mapActivity(item, nowMs))
      : [],
  };
}

function mapGitlabPipelineSummary(
  status: NonNullable<CheckoutPrStatus>,
): GitlabPipelineSummary | undefined {
  const facts = status.forgeSpecific;
  if (facts?.forge !== "gitlab" || facts.pipelineId == null) {
    return undefined;
  }
  const rawStatus = facts.pipelineStatus ?? "";
  return {
    id: facts.pipelineId,
    status: mapPipelineStatus(rawStatus),
    rawStatus,
    url: facts.pipelineUrl ?? null,
  };
}

export function mapPipelineStatus(status: string): CheckStatus {
  switch (status) {
    case "success":
    case "passed":
      return "success";
    case "failed":
      return "failure";
    case "running":
    case "pending":
    case "created":
    case "waiting_for_resource":
    case "preparing":
    case "scheduled":
      return "pending";
    case "canceled":
    case "cancelled":
    case "skipped":
    case "manual":
      return "skipped";
    default:
      return "pending";
  }
}

export function isPipelineActiveStatus(status: string): boolean {
  return (
    status === "running" ||
    status === "pending" ||
    status === "created" ||
    status === "waiting_for_resource" ||
    status === "preparing" ||
    status === "scheduled"
  );
}

export function deriveAvatarColor(login: string): string {
  return AVATAR_COLORS[hashLogin(login) % AVATAR_COLORS.length];
}

export function formatAge(createdAtMs: number, nowMs = Date.now()): string {
  const elapsedMs = Math.max(0, nowMs - createdAtMs);
  const elapsedSeconds = Math.floor(elapsedMs / 1000);

  if (elapsedSeconds < 60) {
    return "just now";
  }

  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) {
    return `${elapsedMinutes}m ago`;
  }

  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) {
    return `${elapsedHours}h ago`;
  }

  const elapsedDays = Math.floor(elapsedHours / 24);
  if (elapsedDays < 30) {
    return `${elapsedDays}d ago`;
  }

  if (elapsedDays < 365) {
    return `${Math.floor(elapsedDays / 30)}mo ago`;
  }

  return `${Math.floor(elapsedDays / 365)}y ago`;
}

function derivePrState(status: NonNullable<CheckoutPrStatus>): PrState {
  if (status.isMerged || status.state === "merged") {
    return "merged";
  }
  if (status.state !== "open") {
    return "closed";
  }
  if (status.isDraft) {
    return "draft";
  }
  return "open";
}

function mapCheck(check: NonNullable<CheckoutPrStatus>["checks"][number]): PrPaneCheck[] {
  if (check.url === null) {
    return [];
  }

  return [
    {
      provider: "github",
      name: check.name,
      status: mapCheckStatus(check.status),
      url: check.url,
      ...(check.workflow ? { workflow: check.workflow } : {}),
      ...(check.duration ? { duration: check.duration } : {}),
      ...(check.checkRunId !== undefined || check.workflowRunId !== undefined
        ? {
            github: {
              ...(check.checkRunId !== undefined ? { checkRunId: check.checkRunId } : {}),
              ...(check.workflowRunId !== undefined ? { workflowRunId: check.workflowRunId } : {}),
            },
          }
        : {}),
    },
  ];
}

function mapCheckStatus(status: string): CheckStatus {
  if (
    status === "success" ||
    status === "failure" ||
    status === "pending" ||
    status === "skipped"
  ) {
    return status;
  }
  if (status === "cancelled") {
    return "skipped";
  }
  return "pending";
}

function mapActivity(item: PullRequestTimelineItem, nowMs: number): PrPaneActivity[] {
  if (item.kind === "comment") {
    if (item.body.trim() === "") {
      return [];
    }
    return [
      {
        id: item.id,
        provider: "github",
        kind: "comment",
        author: item.author,
        authorUrl: item.authorUrl,
        avatarColor: deriveAvatarColor(item.author),
        avatarUrl: item.avatarUrl,
        body: item.body,
        age: formatAge(item.createdAt, nowMs),
        url: item.url,
        reviewId: item.reviewId,
        location: item.location,
      },
    ];
  }

  if (item.reviewState === "commented" && item.body.trim() === "") {
    return [];
  }

  return [
    {
      id: item.id,
      provider: "github",
      kind: "review",
      author: item.author,
      authorUrl: item.authorUrl,
      avatarColor: deriveAvatarColor(item.author),
      avatarUrl: item.avatarUrl,
      reviewState: item.reviewState,
      body: item.body,
      age: formatAge(item.createdAt, nowMs),
      url: item.url,
    },
  ];
}

function mapReviewDecision(
  reviewDecision: NonNullable<CheckoutPrStatus>["reviewDecision"],
): PrPaneData["reviewDecision"] {
  if (reviewDecision === "approved" || reviewDecision === "changes_requested") {
    return reviewDecision;
  }
  return "pending";
}

function parsePullRequestNumber(url: string): number | null {
  try {
    const match = new URL(url).pathname.match(/\/pull\/(\d+)(?:\/|$)/);
    if (!match) {
      return null;
    }

    const number = Number.parseInt(match[1], 10);
    return Number.isFinite(number) ? number : null;
  } catch {
    return null;
  }
}

function hashLogin(login: string): number {
  let hash = 0;
  for (const character of login.toLowerCase()) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }
  return hash;
}

export function getStateLabel(state: PrState): string {
  if (state === "draft") return "Draft";
  if (state === "merged") return "Merged";
  if (state === "closed") return "Closed";
  return "Open";
}

export function getActivityVerb(item: Pick<PrPaneActivity, "kind" | "reviewState">): string {
  if (item.kind === "comment") return "Commented";
  if (item.reviewState === "approved") return "Approved";
  if (item.reviewState === "changes_requested") return "Requested changes";
  return "Reviewed";
}
