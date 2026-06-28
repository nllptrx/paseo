import { z } from "zod";
import { findExecutable } from "../executable-resolution/executable-resolution.js";
import { runGitCommand } from "../utils/run-git-command.js";
import { execCommand } from "../utils/spawn.js";
import { isGiteaStatusFacts } from "./forge-service.js";
import type {
  CheckDetails,
  CreatePullRequestOptions,
  CurrentPullRequestStatus,
  DisablePullRequestAutoMergeOptions,
  EnablePullRequestAutoMergeOptions,
  ForgeReadOptions,
  ForgeService,
  GetCheckDetailsOptions,
  GetPullRequestOptions,
  GetPullRequestTimelineOptions,
  GiteaStatusFacts,
  IssueSummary,
  ListIssuesOptions,
  ListPullRequestsOptions,
  MergePullRequestOptions,
  PullRequestChecksStatus,
  PullRequestCreateResult,
  PullRequestMergeable,
  PullRequestMergeResult,
  PullRequestSummary,
  PullRequestTimeline,
  PullRequestTimelineCommentLocation,
  PullRequestTimelineError,
  PullRequestTimelineErrorKind,
  PullRequestTimelineItem,
  PullRequestTimelineReviewState,
  PullRequestCheck,
  SearchIssuesAndPrsOptions,
  SearchResult,
} from "./forge-service.js";

const TEA_ENV = {
  GIT_TERMINAL_PROMPT: "0",
} as const;

const TEA_COMMAND_TIMEOUT_MS = 30_000;

/**
 * Fields requested from `tea pr list -o json`. tea's default field set omits the
 * ones the neutral mapping needs (url, mergeable, base, head, ci, body), so they
 * must be requested explicitly — otherwise tea silently emits the short default
 * set and the mapping loses data.
 */
const PR_LIST_FIELDS =
  "index,state,author,url,title,body,mergeable,base,head,created,updated,labels,comments,ci";

const ISSUE_LIST_FIELDS = "index,state,author,url,title,body,labels,comments,created,updated";

const PR_STATUS_LOOKUP_LIMIT = 50;
const TIMELINE_PAGE_SIZE = 100;

export class TeaCliMissingError extends Error {
  readonly kind = "missing-cli";

  constructor() {
    super("Gitea CLI (tea) is not installed or not in PATH");
    this.name = "TeaCliMissingError";
  }
}

export class TeaAuthenticationError extends Error {
  readonly kind = "auth-failure";
  readonly stderr: string;

  constructor(params: { stderr: string }) {
    super("Gitea CLI authentication failed");
    this.name = "TeaAuthenticationError";
    this.stderr = params.stderr;
  }
}

export class TeaCommandError extends Error {
  readonly kind = "command-error";
  readonly args: string[];
  readonly cwd: string;
  readonly exitCode: number | null;
  readonly stderr: string;

  constructor(params: { args: string[]; cwd: string; exitCode: number | null; stderr: string }) {
    super(`Gitea CLI command failed: tea ${params.args.join(" ")}`);
    this.name = "TeaCommandError";
    this.args = [...params.args];
    this.cwd = params.cwd;
    this.exitCode = params.exitCode;
    this.stderr = params.stderr;
  }
}

export interface TeaCommandRunnerOptions {
  cwd: string;
  envOverlay?: Record<string, string>;
}

export interface TeaCommandResult {
  stdout: string;
  stderr: string;
}

export type TeaCommandRunner = (
  args: string[],
  options: TeaCommandRunnerOptions,
) => Promise<TeaCommandResult>;

export interface CreateGiteaServiceOptions {
  runner?: TeaCommandRunner;
  resolveTeaPath?: () => Promise<string | null>;
  resolveRemoteUrl?: (cwd: string) => Promise<string | null>;
  resolveCurrentBranch?: (cwd: string) => Promise<string | null>;
}

/**
 * `tea pr list -o json` flattens every value to a string (e.g. `index:"5"`,
 * `mergeable:"false"`, `comments:"0"`), unlike the single-PR view which is
 * natively typed. The list schema therefore parses strings and the mapping
 * coerces; `.passthrough()` tolerates the extra fields tea always includes.
 */
const GiteaPrListItemSchema = z
  .object({
    index: z.string(),
    state: z.string(),
    url: z.string(),
    title: z.string(),
    body: z.string().optional().default(""),
    mergeable: z.string().optional(),
    base: z.string().optional(),
    head: z.string().optional(),
    created: z.string().optional(),
    updated: z.string().optional(),
    labels: z.string().optional(),
    ci: z.string().optional(),
  })
  .passthrough();

const GiteaIssueListItemSchema = z
  .object({
    index: z.string(),
    state: z.string(),
    url: z.string(),
    title: z.string(),
    body: z.string().optional().default(""),
    labels: z.string().optional(),
    updated: z.string().optional(),
  })
  .passthrough();

const GiteaLoginSchema = z
  .object({
    name: z.string().optional(),
    url: z.string().optional(),
    ssh_host: z.string().optional(),
  })
  .passthrough();

const GiteaUserSchema = z
  .object({
    login: z.string().optional(),
    full_name: z.string().optional(),
    avatar_url: z.string().nullable().optional(),
    html_url: z.string().nullable().optional(),
  })
  .passthrough();

const GiteaPullRequestViewSchema = z
  .object({
    index: z.number(),
    url: z.string(),
    headSha: z.string().optional(),
  })
  .passthrough();

const GiteaCommitStatusSchema = z
  .object({
    id: z.number(),
    status: z.string(),
    target_url: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    url: z.string().nullable().optional(),
    context: z.string().optional().default(""),
  })
  .passthrough();

const GiteaCombinedCommitStatusSchema = z
  .object({
    state: z.string().optional().default(""),
    sha: z.string().optional(),
    total_count: z.number().optional(),
    statuses: z.array(GiteaCommitStatusSchema).optional().default([]),
  })
  .passthrough();

const GiteaActionsRunSchema = z
  .object({
    id: z.number(),
    name: z.string().nullable().optional(),
    head_branch: z.string().nullable().optional(),
    head_sha: z.string(),
    run_number: z.number().optional(),
    event: z.string().nullable().optional(),
    display_title: z.string().nullable().optional(),
    status: z.string(),
    workflow_id: z.string().nullable().optional(),
    url: z.string().nullable().optional(),
    created_at: z.string().nullable().optional(),
    run_started_at: z.string().nullable().optional(),
  })
  .passthrough();

const GiteaActionsRunsSchema = z
  .object({
    workflow_runs: z.array(GiteaActionsRunSchema).optional().default([]),
    total_count: z.number().optional(),
  })
  .passthrough();

const GiteaIssueCommentSchema = z
  .object({
    id: z.number(),
    html_url: z.string().optional(),
    user: GiteaUserSchema.nullable().optional(),
    body: z.string().optional().default(""),
    created_at: z.string().optional(),
    type: z.string().optional(),
  })
  .passthrough();

const GiteaReviewSchema = z
  .object({
    id: z.number(),
    user: GiteaUserSchema.nullable().optional(),
    state: z.string(),
    body: z.string().optional().default(""),
    comments_count: z.number().optional().default(0),
    submitted_at: z.string().optional(),
    updated_at: z.string().optional(),
    html_url: z.string().optional(),
  })
  .passthrough();

const GiteaReviewCommentSchema = z
  .object({
    id: z.number(),
    body: z.string().optional().default(""),
    user: GiteaUserSchema.nullable().optional(),
    pull_request_review_id: z.number().optional(),
    created_at: z.string().optional(),
    updated_at: z.string().optional(),
    path: z.string().optional(),
    position: z.number().optional(),
    html_url: z.string().optional(),
  })
  .passthrough();

type GiteaPrListItem = z.infer<typeof GiteaPrListItemSchema>;
type GiteaIssueListItem = z.infer<typeof GiteaIssueListItemSchema>;
type GiteaPullRequestView = z.infer<typeof GiteaPullRequestViewSchema>;
type GiteaCommitStatus = z.infer<typeof GiteaCommitStatusSchema>;
type GiteaCombinedCommitStatus = z.infer<typeof GiteaCombinedCommitStatusSchema>;
type GiteaActionsRun = z.infer<typeof GiteaActionsRunSchema>;
type GiteaActionsRuns = z.infer<typeof GiteaActionsRunsSchema>;
type GiteaIssueComment = z.infer<typeof GiteaIssueCommentSchema>;
type GiteaReview = z.infer<typeof GiteaReviewSchema>;
type GiteaReviewComment = z.infer<typeof GiteaReviewCommentSchema>;

async function resolveTeaPath(): Promise<string | null> {
  return findExecutable("tea");
}

async function runTeaCommand(
  args: string[],
  options: TeaCommandRunnerOptions,
): Promise<TeaCommandResult> {
  return execCommand("tea", args, {
    cwd: options.cwd,
    envOverlay: { ...TEA_ENV, ...options.envOverlay },
    maxBuffer: 10 * 1024 * 1024,
    timeout: TEA_COMMAND_TIMEOUT_MS,
  });
}

async function defaultResolveRemoteUrl(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await runGitCommand(["config", "--get", "remote.origin.url"], { cwd });
    const url = stdout.trim();
    return url.length > 0 ? url : null;
  } catch {
    return null;
  }
}

async function defaultResolveCurrentBranch(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await runGitCommand(["branch", "--show-current"], { cwd });
    const branch = stdout.trim();
    return branch.length > 0 ? branch : null;
  } catch {
    return null;
  }
}

export function parseGiteaHostFromRemoteUrl(url: string): string | null {
  const sshMatch = url.match(/^[^@\s]+@([^:/\s]+):/);
  if (sshMatch) {
    return sshMatch[1];
  }
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

/**
 * tea numeric fields arrive as strings in list output. Returns null for a
 * missing/non-numeric value so callers can decide on a fallback.
 */
function parseGiteaInt(value: string | undefined): number | null {
  if (value === undefined || value.trim() === "") {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseGiteaBool(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === "true";
}

function parseOptionalTime(value: string | undefined): number {
  if (!value) {
    return 0;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function timelineApiPath(input: GetPullRequestTimelineOptions, suffix: string): string {
  const owner = encodeURIComponent(input.repoOwner);
  const repo = encodeURIComponent(input.repoName);
  return `repos/${owner}/${repo}/${suffix}`;
}

function timelinePageQuery(): string {
  return `page=1&limit=${TIMELINE_PAGE_SIZE}`;
}

function giteaUserLogin(user: z.infer<typeof GiteaUserSchema> | null | undefined): string {
  return user?.login ?? user?.full_name ?? "unknown";
}

function giteaUserUrl(user: z.infer<typeof GiteaUserSchema> | null | undefined): string | null {
  return user?.html_url ?? null;
}

function giteaUserAvatar(user: z.infer<typeof GiteaUserSchema> | null | undefined): string | null {
  return user?.avatar_url ?? null;
}

function isGiteaSystemComment(comment: GiteaIssueComment): boolean {
  return comment.type !== undefined && comment.type !== "comment";
}

function toGiteaReviewState(state: string): PullRequestTimelineReviewState {
  switch (state.trim().toUpperCase()) {
    case "APPROVED":
    case "APPROVE":
      return "approved";
    case "REQUEST_CHANGES":
    case "REQUESTED_CHANGES":
    case "CHANGES_REQUESTED":
      return "changes_requested";
    default:
      return "commented";
  }
}

function toGiteaTimelineComment(
  comment: GiteaIssueComment,
  pr: GiteaPullRequestView,
): PullRequestTimelineItem | null {
  if (isGiteaSystemComment(comment)) {
    return null;
  }
  return {
    kind: "comment",
    id: String(comment.id),
    author: giteaUserLogin(comment.user),
    authorUrl: giteaUserUrl(comment.user),
    avatarUrl: giteaUserAvatar(comment.user),
    body: comment.body,
    createdAt: parseOptionalTime(comment.created_at),
    url: comment.html_url ?? `${pr.url}#issuecomment-${comment.id}`,
  };
}

function toGiteaTimelineReview(review: GiteaReview): PullRequestTimelineItem {
  return {
    kind: "review",
    id: String(review.id),
    author: giteaUserLogin(review.user),
    authorUrl: giteaUserUrl(review.user),
    avatarUrl: giteaUserAvatar(review.user),
    body: review.body,
    createdAt: parseOptionalTime(review.submitted_at ?? review.updated_at),
    url: review.html_url ?? "",
    reviewState: toGiteaReviewState(review.state),
  };
}

function toGiteaReviewCommentLocation(
  comment: GiteaReviewComment,
): PullRequestTimelineCommentLocation | undefined {
  if (!comment.path) {
    return undefined;
  }
  return {
    path: comment.path,
    ...(comment.position != null ? { line: comment.position } : {}),
    ...(comment.pull_request_review_id != null
      ? { threadId: String(comment.pull_request_review_id) }
      : {}),
  };
}

function toGiteaTimelineReviewComment(comment: GiteaReviewComment): PullRequestTimelineItem {
  const location = toGiteaReviewCommentLocation(comment);
  return {
    kind: "comment",
    id: String(comment.id),
    author: giteaUserLogin(comment.user),
    authorUrl: giteaUserUrl(comment.user),
    avatarUrl: giteaUserAvatar(comment.user),
    body: comment.body,
    createdAt: parseOptionalTime(comment.created_at ?? comment.updated_at),
    url: comment.html_url ?? "",
    ...(comment.pull_request_review_id != null
      ? { reviewId: String(comment.pull_request_review_id) }
      : {}),
    ...(location ? { location } : {}),
  };
}

function compareTimelineItems(
  left: PullRequestTimelineItem,
  right: PullRequestTimelineItem,
): number {
  if (left.createdAt !== right.createdAt) {
    return left.createdAt - right.createdAt;
  }
  return left.id.localeCompare(right.id);
}

function splitGiteaLabels(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(",")
    .map((label) => label.trim())
    .filter((label) => label.length > 0);
}

/**
 * tea reports a PR head as `owner:branch` for cross-repo PRs and a bare branch
 * for same-repo ones. The neutral head ref is always just the branch name.
 */
function stripHeadOwner(head: string | undefined): string {
  if (!head) {
    return "";
  }
  const colon = head.indexOf(":");
  return colon >= 0 ? head.slice(colon + 1) : head;
}

function mapGiteaState(state: string): string {
  const normalized = state.toLowerCase();
  if (normalized === "open") {
    return "open";
  }
  if (normalized === "merged") {
    return "merged";
  }
  return "closed";
}

function mapGiteaMergeable(item: GiteaPrListItem): PullRequestMergeable {
  if (item.mergeable === undefined) {
    return "UNKNOWN";
  }
  return parseGiteaBool(item.mergeable) ? "MERGEABLE" : "CONFLICTING";
}

function mapGiteaCiStatus(ci: string | undefined): PullRequestChecksStatus {
  switch (ci?.toLowerCase()) {
    case "success":
      return "success";
    case "failure":
    case "error":
      return "failure";
    case "pending":
    case "running":
      return "pending";
    default:
      return "none";
  }
}

function mapGiteaCommitStatus(state: string): PullRequestCheck["status"] {
  switch (state.toLowerCase()) {
    case "success":
      return "success";
    case "failure":
    case "error":
      return "failure";
    case "pending":
      return "pending";
    default:
      return "pending";
  }
}

function mapGiteaActionsRunStatus(status: string): PullRequestCheck["status"] {
  switch (status.toLowerCase()) {
    case "success":
      return "success";
    case "failure":
    case "failed":
    case "error":
      return "failure";
    case "cancelled":
    case "canceled":
      return "cancelled";
    case "skipped":
      return "skipped";
    case "pending":
    case "queued":
    case "waiting":
    case "requested":
    case "running":
    case "in_progress":
    case "blocked":
      return "pending";
    default:
      return "pending";
  }
}

function mapGiteaCombinedStatus(
  state: string,
  checks: PullRequestCheck[],
): PullRequestChecksStatus {
  switch (state.toLowerCase()) {
    case "success":
      return "success";
    case "failure":
    case "error":
      return "failure";
    case "pending":
      return "pending";
    default:
      return computeChecksStatus(checks);
  }
}

function computeChecksStatus(checks: PullRequestCheck[]): PullRequestChecksStatus {
  if (checks.length === 0) {
    return "none";
  }
  if (checks.some((check) => check.status === "failure")) {
    return "failure";
  }
  if (checks.some((check) => check.status === "pending")) {
    return "pending";
  }
  return "success";
}

function toGiteaPullRequestCheck(status: GiteaCommitStatus): PullRequestCheck {
  return {
    name: status.context || `status-${status.id}`,
    status: mapGiteaCommitStatus(status.status),
    url: status.target_url ?? null,
    checkRunId: status.id,
  };
}

function getGiteaActionsRunName(workflowRun: GiteaActionsRun): string {
  return (
    workflowRun.name ||
    workflowRun.display_title ||
    workflowRun.workflow_id ||
    `actions-${workflowRun.id}`
  );
}

function toGiteaActionsPullRequestCheck(workflowRun: GiteaActionsRun): PullRequestCheck {
  return {
    name: getGiteaActionsRunName(workflowRun),
    status: mapGiteaActionsRunStatus(workflowRun.status),
    url: workflowRun.url ?? null,
    workflowRunId: workflowRun.id,
  };
}

function getGiteaActionsWorkflowIdentity(workflowRun: GiteaActionsRun): string {
  return workflowRun.workflow_id || workflowRun.name || `actions-${workflowRun.id}`;
}

function parseGiteaActionsRunTime(workflowRun: GiteaActionsRun): number {
  const timestamp = workflowRun.created_at ?? workflowRun.run_started_at ?? null;
  if (!timestamp) {
    return 0;
  }
  const time = Date.parse(timestamp);
  return Number.isNaN(time) ? 0 : time;
}

function compareGiteaActionsRunRecency(left: GiteaActionsRun, right: GiteaActionsRun): number {
  const leftRunNumber = left.run_number ?? 0;
  const rightRunNumber = right.run_number ?? 0;
  if (leftRunNumber !== rightRunNumber) {
    return leftRunNumber - rightRunNumber;
  }

  const leftTime = parseGiteaActionsRunTime(left);
  const rightTime = parseGiteaActionsRunTime(right);
  if (leftTime !== rightTime) {
    return leftTime - rightTime;
  }

  return left.id - right.id;
}

function latestGiteaActionsRunsByWorkflow(actionsRuns: GiteaActionsRun[]): GiteaActionsRun[] {
  const latestRuns = new Map<string, GiteaActionsRun>();
  for (const workflowRun of actionsRuns) {
    const identity = getGiteaActionsWorkflowIdentity(workflowRun);
    const current = latestRuns.get(identity);
    if (!current || compareGiteaActionsRunRecency(current, workflowRun) < 0) {
      latestRuns.set(identity, workflowRun);
    }
  }
  return [...latestRuns.values()];
}

function combineGiteaChecks(
  commitStatuses: GiteaCommitStatus[],
  actionsRuns: GiteaActionsRun[],
): PullRequestCheck[] {
  const checks = commitStatuses.map(toGiteaPullRequestCheck);
  const seen = new Set(
    checks.map((check) => `${check.name}\u0000${check.url ?? ""}\u0000${check.status}`),
  );
  for (const workflowRun of actionsRuns) {
    const check = toGiteaActionsPullRequestCheck(workflowRun);
    const key = `${check.name}\u0000${check.url ?? ""}\u0000${check.status}`;
    if (!seen.has(key)) {
      checks.push(check);
      seen.add(key);
    }
  }
  return checks;
}

function applyGiteaChecks(
  status: CurrentPullRequestStatus,
  combined: GiteaCombinedCommitStatus,
  actionsRuns: GiteaActionsRun[],
): CurrentPullRequestStatus {
  const checks = combineGiteaChecks(combined.statuses, actionsRuns);
  if (checks.length === 0) {
    return status;
  }
  return {
    ...status,
    checks,
    checksStatus: mapGiteaCombinedStatus(combined.state, checks),
  };
}

/** Parse owner/name from a Gitea PR/issue URL (`https://host/owner/repo/pulls/N`). */
function parseGiteaRepoFromUrl(url: string): { owner?: string; name?: string } {
  try {
    const segments = new URL(url).pathname.split("/").filter((segment) => segment.length > 0);
    if (segments.length >= 2) {
      return { owner: segments[0], name: segments[1] };
    }
  } catch {
    // fall through
  }
  return {};
}

function toPullRequestSummary(item: GiteaPrListItem): PullRequestSummary {
  return {
    number: parseGiteaInt(item.index) ?? 0,
    title: item.title,
    url: item.url,
    state: mapGiteaState(item.state),
    body: item.body || null,
    baseRefName: item.base ?? "",
    headRefName: stripHeadOwner(item.head),
    labels: splitGiteaLabels(item.labels),
    updatedAt: item.updated ?? "",
  };
}

function toIssueSummary(item: GiteaIssueListItem): IssueSummary {
  return {
    number: parseGiteaInt(item.index) ?? 0,
    title: item.title,
    url: item.url,
    state: mapGiteaState(item.state),
    body: item.body || null,
    labels: splitGiteaLabels(item.labels),
    updatedAt: item.updated ?? "",
  };
}

function toGiteaStatusFacts(item: GiteaPrListItem): GiteaStatusFacts {
  return {
    mergeable: parseGiteaBool(item.mergeable),
    hasMerged: mapGiteaState(item.state) === "merged",
    ciStatus: item.ci && item.ci.length > 0 ? item.ci : null,
  };
}

function toCurrentPullRequestStatus(item: GiteaPrListItem): CurrentPullRequestStatus {
  const { owner, name } = parseGiteaRepoFromUrl(item.url);
  const state = mapGiteaState(item.state);
  return {
    number: parseGiteaInt(item.index) ?? undefined,
    ...(owner ? { repoOwner: owner } : {}),
    ...(name ? { repoName: name } : {}),
    ...(owner && name ? { projectPath: `${owner}/${name}` } : {}),
    url: item.url,
    title: item.title,
    state,
    baseRefName: item.base ?? "",
    headRefName: stripHeadOwner(item.head),
    isMerged: state === "merged",
    mergeable: mapGiteaMergeable(item),
    checks: [],
    checksStatus: mapGiteaCiStatus(item.ci),
    reviewDecision: null,
    forgeSpecific: { forge: "gitea", ...toGiteaStatusFacts(item) },
  };
}

/**
 * Server-side guard for a Gitea direct merge, mirroring the gh/glab adapters:
 * refuse the merge unless Gitea reports the PR as mergeable. The resolved status
 * can go stale between the client check and execution, and the RPC can be called
 * directly, so the guard lives here rather than only in the UI policy.
 */
function assertGiteaDirectMergeReady(input: Pick<MergePullRequestOptions, "status">): void {
  const facts = input.status?.forgeSpecific;
  if (!isGiteaStatusFacts(facts)) {
    throw new Error("Gitea merge facts are unavailable for this pull request");
  }
  if (facts.hasMerged) {
    throw new Error("This pull request is already merged");
  }
  if (!facts.mergeable) {
    throw new Error("Gitea does not report this pull request as ready for direct merge");
  }
}

function isAuthFailureText(text: string): boolean {
  return /\b(401|unauthorized|not logged in|authentication failed|no token|invalid token|no logins?)\b/i.test(
    text,
  );
}

function classifyGiteaTimelineErrorKind(stderr: string): PullRequestTimelineErrorKind {
  const normalized = stderr.toLowerCase();
  if (normalized.includes("404") || normalized.includes("not found")) {
    return "not_found";
  }
  if (normalized.includes("403") || normalized.includes("forbidden") || isAuthFailureText(stderr)) {
    return "forbidden";
  }
  return "unknown";
}

function mapGiteaTimelineError(error: unknown): PullRequestTimelineError {
  if (error instanceof TeaAuthenticationError || error instanceof TeaCliMissingError) {
    return { kind: "forbidden", message: error.message };
  }
  if (error instanceof TeaCommandError) {
    return {
      kind: classifyGiteaTimelineErrorKind(error.stderr),
      message: error.stderr || error.message,
    };
  }
  return { kind: "unknown", message: error instanceof Error ? error.message : String(error) };
}

function bufferOrStringToString(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value instanceof Buffer) {
    return value.toString("utf8");
  }
  return "";
}

function normalizeTeaCommandError(error: unknown, context: { args: string[]; cwd: string }): Error {
  if (error instanceof TeaAuthenticationError || error instanceof TeaCliMissingError) {
    return error;
  }
  if (error instanceof TeaCommandError) {
    if (isAuthFailureText(error.stderr)) {
      return new TeaAuthenticationError({ stderr: error.stderr });
    }
    return error;
  }
  const failure = (error ?? {}) as {
    code?: string | number;
    killed?: boolean;
    stderr?: unknown;
    message?: string;
  };
  if (failure.code === "ENOENT") {
    return new TeaCliMissingError();
  }
  const stderr = bufferOrStringToString(failure.stderr);
  const message = failure.message ?? "";
  if (isAuthFailureText(stderr) || isAuthFailureText(message)) {
    return new TeaAuthenticationError({ stderr });
  }
  if (failure.killed === true) {
    return new TeaCommandError({
      args: context.args,
      cwd: context.cwd,
      exitCode: null,
      stderr:
        stderr ||
        `tea was terminated before completing (timed out after ${TEA_COMMAND_TIMEOUT_MS}ms or exceeded the output limit)`,
    });
  }
  return new TeaCommandError({
    args: context.args,
    cwd: context.cwd,
    exitCode: typeof failure.code === "number" ? failure.code : null,
    stderr: stderr || message,
  });
}

function extractPullRequestUrl(stdout: string): string | null {
  const match = stdout.match(/https?:\/\/\S+\/pulls\/\d+/);
  return match ? match[0] : null;
}

function parseIndexFromUrl(url: string): number | null {
  const match = url.match(/\/pulls\/(\d+)/);
  return match ? Number(match[1]) : null;
}

/**
 * Probe whether a host is a Gitea instance Paseo can talk to. tea has no
 * per-repo auth check (it keeps per-instance logins), so a configured tea login
 * for the host is the signal: it means tea both recognizes the host as Gitea and
 * holds a usable token for it. Mirrors the role of `glab auth status` for GitLab.
 */
export async function probeGiteaHost(host: string): Promise<boolean> {
  const teaPath = await findExecutable("tea");
  if (!teaPath) {
    return false;
  }
  try {
    const { stdout } = await execCommand("tea", ["login", "list", "-o", "json"], {
      envOverlay: TEA_ENV,
      timeout: 10_000,
    });
    return hostHasLogin(stdout, host);
  } catch {
    return false;
  }
}

function hostHasLogin(stdout: string, host: string): boolean {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    return false;
  }
  const parsed = z.array(GiteaLoginSchema).safeParse(data);
  if (!parsed.success) {
    return false;
  }
  const target = host.toLowerCase();
  return parsed.data.some((login) => {
    const candidates = [login.ssh_host, login.name];
    if (login.url) {
      try {
        candidates.push(new URL(login.url).hostname);
      } catch {
        // ignore malformed login url
      }
    }
    return candidates.some((candidate) => candidate?.toLowerCase() === target);
  });
}

export function createGiteaService(options: CreateGiteaServiceOptions = {}): ForgeService {
  const runner = options.runner ?? runTeaCommand;
  const resolveTea = options.resolveTeaPath ?? resolveTeaPath;
  const resolveRemoteUrl = options.resolveRemoteUrl ?? defaultResolveRemoteUrl;
  const resolveCurrentBranch = options.resolveCurrentBranch ?? defaultResolveCurrentBranch;

  async function run(args: string[], runOptions: TeaCommandRunnerOptions): Promise<string> {
    const teaPath = await resolveTea();
    if (!teaPath) {
      throw new TeaCliMissingError();
    }
    try {
      const result = await runner(args, runOptions);
      return result.stdout.trim();
    } catch (error) {
      throw normalizeTeaCommandError(error, { args, cwd: runOptions.cwd });
    }
  }

  function runJsonParse<T>(
    args: string[],
    runOptions: TeaCommandRunnerOptions,
    stdout: string,
    schema: z.ZodType<T>,
  ): T {
    let data: unknown;
    try {
      data = JSON.parse(stdout);
    } catch {
      throw new TeaCommandError({
        args,
        cwd: runOptions.cwd,
        exitCode: null,
        stderr: `tea did not return valid JSON (${stdout.length} bytes)`,
      });
    }
    const parsed = schema.safeParse(data);
    if (!parsed.success) {
      throw new TeaCommandError({
        args,
        cwd: runOptions.cwd,
        exitCode: null,
        stderr: `tea JSON did not match the expected schema: ${parsed.error.message}`,
      });
    }
    return parsed.data;
  }

  async function runJsonArray<T>(
    args: string[],
    runOptions: TeaCommandRunnerOptions,
    itemSchema: z.ZodType<T>,
  ): Promise<T[]> {
    const stdout = await run(args, runOptions);
    if (!stdout) {
      return [];
    }
    return runJsonParse(args, runOptions, stdout, z.array(itemSchema));
  }

  async function runJson<T>(
    args: string[],
    runOptions: TeaCommandRunnerOptions,
    schema: z.ZodType<T>,
  ): Promise<T> {
    const stdout = await run(args, runOptions);
    return runJsonParse(args, runOptions, stdout, schema);
  }

  async function listPullRequestItems(input: {
    cwd: string;
    state: "open" | "closed" | "all";
    query?: string;
    limit?: number;
  }): Promise<GiteaPrListItem[]> {
    const args = ["pr", "list", "--fields", PR_LIST_FIELDS, "--state", input.state, "-o", "json"];
    if (typeof input.limit === "number") {
      args.push("--limit", String(input.limit));
    }
    const items = await runJsonArray(args, { cwd: input.cwd }, GiteaPrListItemSchema);
    const query = input.query?.trim().toLowerCase();
    if (!query) {
      return items;
    }
    return items.filter((item) => item.title.toLowerCase().includes(query));
  }

  async function runIssueList(input: {
    cwd: string;
    query?: string;
    limit?: number;
  }): Promise<IssueSummary[]> {
    const args = ["issue", "list", "--fields", ISSUE_LIST_FIELDS, "--state", "open", "-o", "json"];
    if (typeof input.limit === "number") {
      args.push("--limit", String(input.limit));
    }
    const items = await runJsonArray(args, { cwd: input.cwd }, GiteaIssueListItemSchema);
    const query = input.query?.trim().toLowerCase();
    const filtered = query
      ? items.filter((item) => item.title.toLowerCase().includes(query))
      : items;
    return filtered.map(toIssueSummary);
  }

  async function listPullRequestReviewComments(input: {
    cwd: string;
    repoOwner: string;
    repoName: string;
    prNumber: number;
    reviewId: number;
  }): Promise<GiteaReviewComment[]> {
    return runJsonArray(
      [
        "api",
        timelineApiPath(
          input,
          `pulls/${input.prNumber}/reviews/${input.reviewId}/comments?${timelinePageQuery()}`,
        ),
      ],
      { cwd: input.cwd },
      GiteaReviewCommentSchema,
    );
  }

  async function loadCurrentPullRequestStatus(input: {
    cwd: string;
    headRef: string;
  }): Promise<CurrentPullRequestStatus | null> {
    const items = await listPullRequestItems({
      cwd: input.cwd,
      state: "all",
      limit: PR_STATUS_LOOKUP_LIMIT,
    });
    const match = items.find((item) => stripHeadOwner(item.head) === input.headRef);
    if (!match) {
      return null;
    }
    const status = toCurrentPullRequestStatus(match);
    return loadCurrentPullRequestChecks(input.cwd, match, status);
  }

  async function loadCurrentPullRequestChecks(
    cwd: string,
    item: GiteaPrListItem,
    status: CurrentPullRequestStatus,
  ): Promise<CurrentPullRequestStatus> {
    const number = parseGiteaInt(item.index);
    if (number === null || !status.repoOwner || !status.repoName) {
      return status;
    }
    try {
      const pr = await runJson(
        ["pr", String(number), "-o", "json"],
        { cwd },
        GiteaPullRequestViewSchema,
      );
      if (!pr.headSha) {
        return status;
      }
      const [combined, actionsRuns] = await Promise.all([
        loadCombinedCommitStatusBestEffort({
          cwd,
          repoOwner: status.repoOwner,
          repoName: status.repoName,
          sha: pr.headSha,
        }),
        loadActionsRunsBestEffort({
          cwd,
          repoOwner: status.repoOwner,
          repoName: status.repoName,
          sha: pr.headSha,
        }),
      ]);
      return applyGiteaChecks(status, combined, actionsRuns);
    } catch {
      return status;
    }
  }

  async function loadCombinedCommitStatusBestEffort(input: {
    cwd: string;
    repoOwner: string;
    repoName: string;
    sha: string;
  }): Promise<GiteaCombinedCommitStatus> {
    try {
      return await loadCombinedCommitStatus(input);
    } catch {
      return { state: "", statuses: [], total_count: 0 };
    }
  }

  async function loadCombinedCommitStatus(input: {
    cwd: string;
    repoOwner: string;
    repoName: string;
    sha: string;
  }): Promise<GiteaCombinedCommitStatus> {
    const owner = encodeURIComponent(input.repoOwner);
    const repo = encodeURIComponent(input.repoName);
    const sha = encodeURIComponent(input.sha);
    return runJson(
      ["api", `repos/${owner}/${repo}/commits/${sha}/status`],
      { cwd: input.cwd },
      GiteaCombinedCommitStatusSchema,
    );
  }

  async function loadActionsRunsBestEffort(input: {
    cwd: string;
    repoOwner: string;
    repoName: string;
    sha: string;
  }): Promise<GiteaActionsRun[]> {
    try {
      const runs = await loadActionsRuns(input);
      const matchingRuns = runs.workflow_runs.filter(
        (workflowRun) => workflowRun.head_sha === input.sha,
      );
      return latestGiteaActionsRunsByWorkflow(matchingRuns);
    } catch {
      return [];
    }
  }

  async function loadActionsRuns(input: {
    cwd: string;
    repoOwner: string;
    repoName: string;
  }): Promise<GiteaActionsRuns> {
    const owner = encodeURIComponent(input.repoOwner);
    const repo = encodeURIComponent(input.repoName);
    return runJson(
      ["api", `repos/${owner}/${repo}/actions/tasks`],
      { cwd: input.cwd },
      GiteaActionsRunsSchema,
    );
  }

  async function resolveCurrentPullRequestHeadSha(cwd: string): Promise<string> {
    const headRef = await resolveCurrentBranch(cwd);
    if (!headRef) {
      throw new Error("Gitea check details require a current branch");
    }
    const items = await listPullRequestItems({
      cwd,
      state: "all",
      limit: PR_STATUS_LOOKUP_LIMIT,
    });
    const match = items.find((item) => stripHeadOwner(item.head) === headRef);
    const number = match ? parseGiteaInt(match.index) : null;
    if (!match || number === null) {
      throw new Error(`Gitea pull request for branch ${headRef} was not found`);
    }
    const pr = await runJson(
      ["pr", String(number), "-o", "json"],
      { cwd },
      GiteaPullRequestViewSchema,
    );
    if (!pr.headSha) {
      throw new Error(`Gitea pull request #${number} did not include a head SHA`);
    }
    return pr.headSha;
  }

  function toGiteaCheckDetails(status: GiteaCommitStatus): CheckDetails {
    return {
      checkRunId: status.id,
      name: status.context || `status-${status.id}`,
      status: status.status,
      conclusion: mapGiteaCommitStatus(status.status),
      url: status.target_url ?? null,
      detailsUrl: status.url ?? null,
      output:
        status.description != null
          ? {
              title: status.context || null,
              summary: status.description,
              text: null,
            }
          : null,
      annotations: [],
      failedJobs: [],
      truncated: false,
    };
  }

  function toGiteaActionsCheckDetails(workflowRun: GiteaActionsRun): CheckDetails {
    const conclusion = mapGiteaActionsRunStatus(workflowRun.status);
    return {
      checkRunId: workflowRun.id,
      workflowRunId: workflowRun.id,
      name: getGiteaActionsRunName(workflowRun),
      status: workflowRun.status,
      conclusion,
      url: workflowRun.url ?? null,
      detailsUrl: workflowRun.url ?? null,
      output: {
        title: workflowRun.display_title ?? workflowRun.name ?? workflowRun.workflow_id ?? null,
        summary: workflowRun.workflow_id ?? null,
        text: null,
      },
      annotations: [],
      failedJobs: [],
      truncated: false,
    };
  }

  function notSupported(method: string): never {
    throw new Error(`${method} is not supported on Gitea yet`);
  }

  return {
    async isAuthenticated(input: { cwd: string } & ForgeReadOptions): Promise<boolean> {
      const teaPath = await resolveTea();
      if (!teaPath) {
        return false;
      }
      const remoteUrl = await resolveRemoteUrl(input.cwd);
      const host = remoteUrl ? parseGiteaHostFromRemoteUrl(remoteUrl) : null;
      if (!host) {
        return false;
      }
      try {
        const stdout = await run(["login", "list", "-o", "json"], { cwd: input.cwd });
        return hostHasLogin(stdout, host);
      } catch {
        return false;
      }
    },

    getCurrentPullRequestStatus(input): Promise<CurrentPullRequestStatus | null> {
      return loadCurrentPullRequestStatus({ cwd: input.cwd, headRef: input.headRef });
    },

    async getPullRequest(input: GetPullRequestOptions): Promise<PullRequestSummary> {
      const items = await listPullRequestItems({
        cwd: input.cwd,
        state: "all",
        limit: PR_STATUS_LOOKUP_LIMIT,
      });
      const match = items.find((item) => parseGiteaInt(item.index) === input.number);
      if (!match) {
        throw new TeaCommandError({
          args: ["pr", "list"],
          cwd: input.cwd,
          exitCode: null,
          stderr: `Gitea pull request #${input.number} was not found`,
        });
      }
      return toPullRequestSummary(match);
    },

    async getPullRequestHeadRef(input: GetPullRequestOptions): Promise<string> {
      const summary = await this.getPullRequest(input);
      return summary.headRefName;
    },

    listPullRequests(input: ListPullRequestsOptions): Promise<PullRequestSummary[]> {
      return listPullRequestItems({
        cwd: input.cwd,
        state: "open",
        query: input.query,
        limit: input.limit,
      }).then((items) => items.map(toPullRequestSummary));
    },

    listIssues(input: ListIssuesOptions): Promise<IssueSummary[]> {
      return runIssueList(input);
    },

    async createPullRequest(input: CreatePullRequestOptions): Promise<PullRequestCreateResult> {
      const args = [
        "pr",
        "create",
        "--title",
        input.title,
        "--description",
        input.body ?? "",
        "--head",
        input.head,
        "--base",
        input.base,
      ];
      const stdout = await run(args, { cwd: input.cwd });
      const url = extractPullRequestUrl(stdout);
      if (!url) {
        throw new TeaCommandError({
          args,
          cwd: input.cwd,
          exitCode: null,
          stderr: "tea reported a created pull request but returned no URL",
        });
      }
      const number = parseIndexFromUrl(url);
      if (number === null) {
        throw new TeaCommandError({
          args,
          cwd: input.cwd,
          exitCode: null,
          stderr: `tea returned a pull request URL without an index: ${url}`,
        });
      }
      return { url, number };
    },

    async mergePullRequest(input: MergePullRequestOptions): Promise<PullRequestMergeResult> {
      assertGiteaDirectMergeReady(input);
      const args = ["pr", "merge", String(input.prNumber), "--style", input.mergeMethod];
      await run(args, { cwd: input.cwd });
      return { success: true };
    },

    async getPullRequestTimeline(
      input: GetPullRequestTimelineOptions,
    ): Promise<PullRequestTimeline> {
      const identity = {
        prNumber: input.prNumber,
        repoOwner: input.repoOwner,
        repoName: input.repoName,
      };
      try {
        const pr = await runJson(
          ["pr", String(input.prNumber), "-o", "json"],
          { cwd: input.cwd },
          GiteaPullRequestViewSchema,
        );
        const [commentsResult, reviewsResult] = await Promise.allSettled([
          runJsonArray(
            [
              "api",
              timelineApiPath(input, `issues/${input.prNumber}/comments?${timelinePageQuery()}`),
            ],
            { cwd: input.cwd },
            GiteaIssueCommentSchema,
          ),
          runJsonArray(
            [
              "api",
              timelineApiPath(input, `pulls/${input.prNumber}/reviews?${timelinePageQuery()}`),
            ],
            { cwd: input.cwd },
            GiteaReviewSchema,
          ),
        ]);
        if (commentsResult.status === "rejected" && reviewsResult.status === "rejected") {
          return {
            ...identity,
            items: [],
            truncated: false,
            error: mapGiteaTimelineError(commentsResult.reason),
          };
        }
        const comments = commentsResult.status === "fulfilled" ? commentsResult.value : [];
        const reviews = reviewsResult.status === "fulfilled" ? reviewsResult.value : [];
        const reviewCommentResults = await Promise.allSettled(
          reviews
            .filter((review) => review.comments_count > 0)
            .map((review) =>
              listPullRequestReviewComments({
                cwd: input.cwd,
                repoOwner: input.repoOwner,
                repoName: input.repoName,
                prNumber: input.prNumber,
                reviewId: review.id,
              }),
            ),
        );
        const reviewCommentGroups = reviewCommentResults
          .filter((result): result is PromiseFulfilledResult<GiteaReviewComment[]> => {
            return result.status === "fulfilled";
          })
          .map((result) => result.value);
        const reviewComments = reviewCommentGroups.flat();
        const items = [
          ...comments.map((comment) => toGiteaTimelineComment(comment, pr)),
          ...reviews.map(toGiteaTimelineReview),
          ...reviewComments.map(toGiteaTimelineReviewComment),
        ]
          .filter((item): item is PullRequestTimelineItem => item !== null)
          .sort(compareTimelineItems);
        return {
          ...identity,
          items,
          truncated:
            comments.length >= TIMELINE_PAGE_SIZE ||
            reviews.length >= TIMELINE_PAGE_SIZE ||
            reviewCommentGroups.some((group) => group.length >= TIMELINE_PAGE_SIZE),
          error: null,
        };
      } catch (error) {
        return { ...identity, items: [], truncated: false, error: mapGiteaTimelineError(error) };
      }
    },

    async getGitHubCheckDetails(input: GetCheckDetailsOptions): Promise<CheckDetails> {
      if (!input.repoOwner || !input.repoName) {
        throw new Error("Gitea getGitHubCheckDetails requires repoOwner and repoName");
      }
      const sha = await resolveCurrentPullRequestHeadSha(input.cwd);
      const combined = await loadCombinedCommitStatusBestEffort({
        cwd: input.cwd,
        repoOwner: input.repoOwner,
        repoName: input.repoName,
        sha,
      });
      const status = combined.statuses.find((entry) => entry.id === input.checkRunId);
      if (status) {
        return toGiteaCheckDetails(status);
      }
      const runs = await loadActionsRunsBestEffort({
        cwd: input.cwd,
        repoOwner: input.repoOwner,
        repoName: input.repoName,
        sha,
      });
      const workflowRunId = input.workflowRunId ?? input.checkRunId;
      const workflowRun = runs.find((entry) => entry.id === workflowRunId);
      if (!workflowRun) {
        throw new Error(`Gitea check ${input.checkRunId} was not found`);
      }
      return toGiteaActionsCheckDetails(workflowRun);
    },

    async searchIssuesAndPrs(input: SearchIssuesAndPrsOptions): Promise<SearchResult> {
      if (input.force && !input.reason) {
        throw new Error("ForgeService forced read requires a reason");
      }

      const kinds = input.kinds ?? ["github-issue", "github-pr"];
      const shouldFetchIssues = kinds.includes("github-issue");
      const shouldFetchMergeRequests = kinds.includes("github-pr");
      const [issuesResult, mergeRequestsResult] = await Promise.allSettled([
        shouldFetchIssues
          ? runIssueList({ cwd: input.cwd, query: input.query, limit: input.limit })
          : Promise.resolve(null),
        shouldFetchMergeRequests
          ? listPullRequestItems({
              cwd: input.cwd,
              state: "open",
              query: input.query,
              limit: input.limit,
            }).then((items) => items.map(toPullRequestSummary))
          : Promise.resolve(null),
      ]);

      const requestedResults = [
        shouldFetchIssues ? issuesResult : null,
        shouldFetchMergeRequests ? mergeRequestsResult : null,
      ].filter((result) => result !== null);
      const everyRequestRejectedForAuth =
        requestedResults.length > 0 &&
        requestedResults.every(
          (result) =>
            result.status === "rejected" &&
            (result.reason instanceof TeaCliMissingError ||
              result.reason instanceof TeaAuthenticationError),
        );
      if (everyRequestRejectedForAuth) {
        return { items: [], githubFeaturesEnabled: false };
      }

      const items: SearchResult["items"] = [];
      if (shouldFetchIssues && issuesResult.status === "fulfilled") {
        for (const issue of issuesResult.value ?? []) {
          items.push({
            kind: "issue",
            number: issue.number,
            title: issue.title,
            url: issue.url,
            state: issue.state,
            body: issue.body,
            labels: issue.labels,
            baseRefName: null,
            headRefName: null,
            updatedAt: issue.updatedAt,
          });
        }
      }
      if (shouldFetchMergeRequests && mergeRequestsResult.status === "fulfilled") {
        for (const pullRequest of mergeRequestsResult.value ?? []) {
          items.push({
            kind: "pr",
            number: pullRequest.number,
            title: pullRequest.title,
            url: pullRequest.url,
            state: pullRequest.state,
            body: pullRequest.body,
            labels: pullRequest.labels,
            baseRefName: pullRequest.baseRefName,
            headRefName: pullRequest.headRefName,
            updatedAt: pullRequest.updatedAt,
          });
        }
      }
      items.sort(
        (left, right) => parseOptionalTime(right.updatedAt) - parseOptionalTime(left.updatedAt),
      );

      return { items, githubFeaturesEnabled: true };
    },

    enablePullRequestAutoMerge(_input: EnablePullRequestAutoMergeOptions): never {
      return notSupported("enablePullRequestAutoMerge");
    },

    disablePullRequestAutoMerge(_input: DisablePullRequestAutoMergeOptions): never {
      return notSupported("disablePullRequestAutoMerge");
    },

    invalidate(_input: { cwd: string }): void {},
  };
}
