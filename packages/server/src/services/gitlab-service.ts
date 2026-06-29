import { z } from "zod";
import { GITLAB_ACTIVE_PIPELINE_STATUSES } from "@getpaseo/protocol/forge-constants";
import { parseGitRemoteLocation } from "@getpaseo/protocol/git-remote";
import { findExecutable } from "../executable-resolution/executable-resolution.js";
import { runGitCommand } from "../utils/run-git-command.js";
import { execCommand } from "../utils/spawn.js";
import { normalizeCliCommandError, parseCliJsonOutput } from "./forge-cli-command.js";
import { createUnavailableSearchResult, normalizeForgeSearchKinds } from "./forge-service.js";
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
  GitLabStatusFacts,
  IssueSummary,
  ListIssuesOptions,
  ListPullRequestsOptions,
  MergePullRequestOptions,
  PipelineDetails,
  PipelineJob,
  PipelineJobStatus,
  PipelineStage,
  PullRequestAutoMergeResult,
  PullRequestChecksStatus,
  PullRequestCheckoutTarget,
  PullRequestCreateResult,
  PullRequestMergeable,
  PullRequestMergeResult,
  PullRequestSummary,
  PullRequestTimeline,
  PullRequestTimelineCommentLocation,
  PullRequestTimelineError,
  PullRequestTimelineErrorKind,
  PullRequestTimelineItem,
  SearchIssuesAndPrsOptions,
  SearchResult,
} from "./forge-service.js";

const GLAB_ENV = {
  GIT_TERMINAL_PROMPT: "0",
  GLAB_CHECK_UPDATE: "0",
} as const;

const GLAB_COMMAND_TIMEOUT_MS = 30_000;
const GITLAB_HOST_PROBE_TIMEOUT_MS = 5_000;

type GitLabHostProbeFetch = (
  url: string,
  init: {
    headers: Record<string, string>;
    method: "GET";
    signal: AbortSignal;
  },
) => Promise<Response>;

export class GlabCliMissingError extends Error {
  readonly kind = "missing-cli";

  constructor() {
    super("GitLab CLI (glab) is not installed or not in PATH");
    this.name = "GlabCliMissingError";
  }
}

export class GlabAuthenticationError extends Error {
  readonly kind = "auth-failure";
  readonly stderr: string;

  constructor(params: { stderr: string }) {
    super("GitLab CLI authentication failed");
    this.name = "GlabAuthenticationError";
    this.stderr = params.stderr;
  }
}

export class GlabCommandError extends Error {
  readonly kind = "command-error";
  readonly args: string[];
  readonly cwd: string;
  readonly exitCode: number | null;
  readonly stderr: string;

  constructor(params: { args: string[]; cwd: string; exitCode: number | null; stderr: string }) {
    super(`GitLab CLI command failed: glab ${params.args.join(" ")}`);
    this.name = "GlabCommandError";
    this.args = [...params.args];
    this.cwd = params.cwd;
    this.exitCode = params.exitCode;
    this.stderr = params.stderr;
  }
}

export interface GlabCommandRunnerOptions {
  cwd: string;
  envOverlay?: Record<string, string>;
}

export interface GlabCommandResult {
  stdout: string;
  stderr: string;
}

export type GlabCommandRunner = (
  args: string[],
  options: GlabCommandRunnerOptions,
) => Promise<GlabCommandResult>;

export interface CreateGitLabServiceOptions {
  runner?: GlabCommandRunner;
  resolveGlabPath?: () => Promise<string | null>;
  resolveRemoteUrl?: (cwd: string) => Promise<string | null>;
}

const GitLabPipelineSchema = z
  .object({
    id: z.number().optional(),
    status: z.string().optional(),
    web_url: z.string().optional(),
  })
  .passthrough();

const GitLabPipelineJobSchema = z
  .object({
    id: z.number(),
    name: z.string(),
    stage: z.string(),
    status: z.string(),
    allow_failure: z.boolean().optional(),
    web_url: z.string().nullable().optional(),
    duration: z.number().nullable().optional(),
  })
  .passthrough();

const GitLabPipelineDetailsSchema = z
  .object({
    id: z.number(),
    status: z.string(),
    ref: z.string().nullable().optional(),
    sha: z.string().nullable().optional(),
    web_url: z.string().nullable().optional(),
    jobs: z.array(GitLabPipelineJobSchema).optional().default([]),
  })
  .passthrough();

const GitLabMergeRequestSchema = z
  .object({
    iid: z.number(),
    title: z.string(),
    web_url: z.string(),
    state: z.string(),
    source_branch: z.string(),
    target_branch: z.string(),
    source_project_id: z.number().nullable().optional(),
    target_project_id: z.number().nullable().optional(),
    draft: z.boolean().optional(),
    work_in_progress: z.boolean().optional(),
    has_conflicts: z.boolean().optional(),
    blocking_discussions_resolved: z.boolean().optional(),
    merge_when_pipeline_succeeds: z.boolean().optional(),
    approvals_required: z.number().nullable().optional(),
    approvals_given: z.number().nullable().optional(),
    merged_at: z.string().nullable().optional(),
    detailed_merge_status: z.string().optional(),
    description: z.string().nullable().optional(),
    labels: z.array(z.string()).optional(),
    updated_at: z.string().optional(),
    references: z.object({ full: z.string().optional() }).passthrough().optional(),
    head_pipeline: GitLabPipelineSchema.nullable().optional(),
  })
  .passthrough();

const GitLabIssueSchema = z
  .object({
    iid: z.number(),
    title: z.string(),
    web_url: z.string(),
    state: z.string(),
    description: z.string().nullable().optional(),
    labels: z.array(z.string()).optional(),
    updated_at: z.string().optional(),
    references: z.object({ full: z.string().optional() }).passthrough().optional(),
  })
  .passthrough();

const GitLabNoteAuthorSchema = z
  .object({
    username: z.string().optional(),
    name: z.string().optional(),
    web_url: z.string().nullable().optional(),
    avatar_url: z.string().nullable().optional(),
  })
  .passthrough();

const GitLabNoteLineRangeEndpointSchema = z
  .object({
    new_line: z.number().nullable().optional(),
    old_line: z.number().nullable().optional(),
  })
  .passthrough();

const GitLabNotePositionSchema = z
  .object({
    new_path: z.string().nullable().optional(),
    old_path: z.string().nullable().optional(),
    new_line: z.number().nullable().optional(),
    old_line: z.number().nullable().optional(),
    line_range: z
      .object({
        start: GitLabNoteLineRangeEndpointSchema.nullable().optional(),
        end: GitLabNoteLineRangeEndpointSchema.nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

const GitLabNoteSchema = z
  .object({
    id: z.number(),
    body: z.string().nullable().optional(),
    system: z.boolean().optional(),
    type: z.string().nullable().optional(),
    created_at: z.string().nullable().optional(),
    resolvable: z.boolean().optional(),
    resolved: z.boolean().optional(),
    author: GitLabNoteAuthorSchema.nullable().optional(),
    position: GitLabNotePositionSchema.nullable().optional(),
  })
  .passthrough();

const GitLabDiscussionSchema = z
  .object({
    id: z.string(),
    individual_note: z.boolean().optional(),
    notes: z.array(GitLabNoteSchema).optional().default([]),
  })
  .passthrough();

const GitLabApprovalsSchema = z
  .object({
    approvals_required: z.number().nullable().optional(),
    approvals_left: z.number().nullable().optional(),
    approved_by: z.array(z.unknown()).nullable().optional(),
  })
  .passthrough();

type GitLabMergeRequest = z.infer<typeof GitLabMergeRequestSchema>;
type GitLabIssue = z.infer<typeof GitLabIssueSchema>;
type GitLabNote = z.infer<typeof GitLabNoteSchema>;
type GitLabNoteLineRangeEndpoint = z.infer<typeof GitLabNoteLineRangeEndpointSchema>;
type GitLabDiscussion = z.infer<typeof GitLabDiscussionSchema>;
type GitLabApprovals = z.infer<typeof GitLabApprovalsSchema>;

const TIMELINE_PAGE_SIZE = 100;

async function resolveGlabPath(): Promise<string | null> {
  return findExecutable("glab");
}

async function runGlabCommand(
  args: string[],
  options: GlabCommandRunnerOptions,
): Promise<GlabCommandResult> {
  return execCommand("glab", args, {
    cwd: options.cwd,
    envOverlay: { ...GLAB_ENV, ...options.envOverlay },
    maxBuffer: 10 * 1024 * 1024,
    timeout: GLAB_COMMAND_TIMEOUT_MS,
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

export function parseGitLabHostFromRemoteUrl(url: string): string | null {
  return parseGitRemoteLocation(url)?.host ?? null;
}

function mapMergeRequestState(state: string): string {
  return state === "opened" ? "open" : "closed";
}

function mapMergeable(mr: GitLabMergeRequest): PullRequestMergeable {
  if (mr.has_conflicts === true) {
    return "CONFLICTING";
  }
  if (mr.detailed_merge_status === "mergeable") {
    return "MERGEABLE";
  }
  return "UNKNOWN";
}

function mapPipelineChecksStatus(status: string | undefined): PullRequestChecksStatus {
  switch (status) {
    case "success":
    case "passed":
      return "success";
    case "failed":
    case "canceled":
    case "cancelled":
      return "failure";
    case "running":
    case "pending":
    case "created":
    case "scheduled":
    case "preparing":
    case "waiting_for_resource":
    case "manual":
      return "pending";
    default:
      return "none";
  }
}

function splitProjectPath(fullReference: string | undefined): {
  owner?: string;
  name?: string;
} {
  if (!fullReference) {
    return {};
  }
  const projectPath = fullReference.split("!")[0]?.split("#")[0];
  if (!projectPath) {
    return {};
  }
  const segments = projectPath.split("/").filter((segment) => segment.length > 0);
  if (segments.length === 0) {
    return {};
  }
  return { owner: segments[0], name: segments[segments.length - 1] };
}

function toPullRequestSummary(mr: GitLabMergeRequest): PullRequestSummary {
  const projectPath = extractProjectPath(mr.references?.full);
  return {
    number: mr.iid,
    title: mr.title,
    url: mr.web_url,
    state: mapMergeRequestState(mr.state),
    body: mr.description ?? null,
    baseRefName: mr.target_branch,
    headRefName: mr.source_branch,
    labels: mr.labels ?? [],
    ...(projectPath ? { projectPath } : {}),
    updatedAt: mr.updated_at ?? "",
  };
}

function toIssueSummary(issue: GitLabIssue): IssueSummary {
  const projectPath = extractProjectPath(issue.references?.full);
  return {
    number: issue.iid,
    title: issue.title,
    url: issue.web_url,
    state: issue.state,
    body: issue.description ?? null,
    labels: issue.labels ?? [],
    ...(projectPath ? { projectPath } : {}),
    updatedAt: issue.updated_at ?? "",
  };
}

function extractProjectPath(fullReference: string | undefined): string | undefined {
  if (!fullReference) {
    return undefined;
  }
  const projectPath = fullReference.split("!")[0]?.split("#")[0];
  return projectPath && projectPath.length > 0 ? projectPath : undefined;
}

function countApprovalsGiven(approvals: GitLabApprovals | null | undefined): number | null {
  if (!approvals) {
    return null;
  }
  if (Array.isArray(approvals.approved_by)) {
    return approvals.approved_by.length;
  }
  if (approvals.approvals_required != null && approvals.approvals_left != null) {
    return Math.max(0, approvals.approvals_required - approvals.approvals_left);
  }
  return null;
}

function toGitLabStatusFacts(
  mr: GitLabMergeRequest,
  approvals?: GitLabApprovals | null,
): GitLabStatusFacts {
  return {
    detailedMergeStatus: mr.detailed_merge_status ?? null,
    hasConflicts: mr.has_conflicts ?? false,
    blockingDiscussionsResolved: mr.blocking_discussions_resolved ?? true,
    approvalsRequired: approvals?.approvals_required ?? mr.approvals_required ?? 0,
    approvalsGiven: countApprovalsGiven(approvals) ?? mr.approvals_given ?? 0,
    pipelineStatus: mr.head_pipeline?.status ?? null,
    pipelineId: mr.head_pipeline?.id ?? null,
    pipelineUrl: mr.head_pipeline?.web_url ?? null,
    mergeWhenPipelineSucceeds: mr.merge_when_pipeline_succeeds ?? false,
  };
}

function parseGitLabTimestamp(value: string | null | undefined): number {
  if (!value) {
    return 0;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * A GitLab discussion is a reply chain when it is not an explicit standalone
 * note (`individual_note: true`). Older payloads may omit the flag, so a
 * discussion that already holds multiple notes is also treated as a thread.
 */
function isThreadDiscussion(discussion: GitLabDiscussion): boolean {
  if (discussion.individual_note === true) {
    return false;
  }
  return discussion.individual_note === false || discussion.notes.length > 1;
}

function resolvePositionLine(endpoint: GitLabNoteLineRangeEndpoint): number | undefined {
  return endpoint.new_line ?? endpoint.old_line ?? undefined;
}

function toTimelineCommentLocation(
  note: GitLabNote,
  discussion: GitLabDiscussion,
): PullRequestTimelineCommentLocation | undefined {
  const position = note.position;
  const path = position?.new_path ?? position?.old_path ?? undefined;
  if (!position || !path) {
    return undefined;
  }
  const line = resolvePositionLine(position);
  const start = position.line_range?.start;
  const startLine = start ? resolvePositionLine(start) : undefined;
  // Only emit a resolution state GitLab can actually own: a note that is not
  // resolvable (ordinary comments, system context) has no meaningful resolved
  // flag, and defaulting it to `false` would render a fake "unresolved" badge.
  const isResolved = note.resolvable === true ? (note.resolved ?? false) : undefined;
  return {
    path,
    ...(line != null ? { line } : {}),
    ...(startLine != null && startLine !== line ? { startLine } : {}),
    threadId: discussion.id,
    ...(isResolved !== undefined ? { isResolved } : {}),
  };
}

/**
 * Maps a GitLab note to a neutral timeline item. The forge has no GitHub-style
 * review verdict on a note, so every human note becomes a `comment`; approvals
 * are surfaced separately on the status facts, not as timeline reviews. System
 * notes (events like "approved", "mentioned in commit") are dropped.
 */
function toTimelineComment(
  note: GitLabNote,
  discussion: GitLabDiscussion,
  mrWebUrl: string,
): PullRequestTimelineItem | null {
  if (note.system === true) {
    return null;
  }
  const location = toTimelineCommentLocation(note, discussion);
  // Top-level thread id groups every note of a reply chain — including general
  // (non-file) discussions that carry no `location` — into one timeline thread.
  const threadId = isThreadDiscussion(discussion) ? discussion.id : undefined;
  // A resolvable discussion without a file position (a general thread) carries its
  // resolution here, since `location.isResolved` only exists for file threads.
  const threadIsResolved =
    !location && note.resolvable === true ? (note.resolved ?? false) : undefined;
  return {
    kind: "comment",
    id: String(note.id),
    author: note.author?.username ?? note.author?.name ?? "unknown",
    authorUrl: note.author?.web_url ?? null,
    avatarUrl: note.author?.avatar_url ?? null,
    body: note.body ?? "",
    createdAt: parseGitLabTimestamp(note.created_at),
    url: `${mrWebUrl}#note_${note.id}`,
    ...(threadId ? { threadId } : {}),
    ...(threadIsResolved !== undefined ? { threadIsResolved } : {}),
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

function classifyGlabTimelineErrorKind(stderr: string): PullRequestTimelineErrorKind {
  const normalized = stderr.toLowerCase();
  if (normalized.includes("404") || normalized.includes("not found")) {
    return "not_found";
  }
  if (normalized.includes("403") || normalized.includes("forbidden") || isAuthFailureText(stderr)) {
    return "forbidden";
  }
  return "unknown";
}

function mapGlabTimelineError(error: unknown): PullRequestTimelineError {
  if (error instanceof GlabAuthenticationError) {
    return { kind: "forbidden", message: error.stderr || error.message };
  }
  if (error instanceof GlabCommandError) {
    return {
      kind: classifyGlabTimelineErrorKind(error.stderr),
      message: error.stderr || error.message,
    };
  }
  return { kind: "unknown", message: error instanceof Error ? error.message : String(error) };
}

function normalizePipelineJobStatus(raw: string): PipelineJobStatus {
  switch (raw) {
    case "success":
    case "passed":
      return "success";
    case "failed":
      return "failed";
    case "running":
      return "running";
    case "pending":
    case "waiting_for_resource":
    case "preparing":
    case "scheduled":
      return "pending";
    case "created":
      return "created";
    case "canceled":
    case "cancelled":
      return "canceled";
    case "skipped":
      return "skipped";
    case "manual":
      return "manual";
    default:
      return "unknown";
  }
}

const STAGE_STATUS_PRIORITY: PipelineJobStatus[] = [
  "running",
  "failed",
  "pending",
  "created",
  "manual",
  "canceled",
  "skipped",
  "success",
];

function aggregateStageStatus(jobs: PipelineJob[]): PipelineJobStatus {
  const present = new Set(
    jobs.map((job) => (job.status === "failed" && job.allowFailure ? "success" : job.status)),
  );
  for (const status of STAGE_STATUS_PRIORITY) {
    if (present.has(status)) {
      return status;
    }
  }
  return "unknown";
}

function toPipelineDetails(pipeline: z.infer<typeof GitLabPipelineDetailsSchema>): PipelineDetails {
  // glab returns jobs newest-first; ascending id restores creation order.
  const jobs: PipelineJob[] = [...pipeline.jobs]
    .sort((a, b) => a.id - b.id)
    .map((job) => ({
      id: job.id,
      name: job.name,
      stage: job.stage,
      status: normalizePipelineJobStatus(job.status),
      rawStatus: job.status,
      url: job.web_url ?? null,
      allowFailure: job.allow_failure ?? false,
      durationSeconds: job.duration ?? null,
    }));

  const stages: PipelineStage[] = [];
  const stageIndex = new Map<string, PipelineStage>();
  for (const job of jobs) {
    let stage = stageIndex.get(job.stage);
    if (!stage) {
      stage = { name: job.stage, status: "unknown", jobs: [] };
      stageIndex.set(job.stage, stage);
      stages.push(stage);
    }
    stage.jobs.push(job);
  }
  for (const stage of stages) {
    stage.status = aggregateStageStatus(stage.jobs);
  }

  return {
    id: pipeline.id,
    status: normalizePipelineJobStatus(pipeline.status),
    rawStatus: pipeline.status,
    url: pipeline.web_url ?? null,
    ref: pipeline.ref ?? null,
    sha: pipeline.sha ?? null,
    stages,
  };
}

function toCheckDetails(pipeline: z.infer<typeof GitLabPipelineDetailsSchema>): CheckDetails {
  return {
    checkRunId: pipeline.id,
    workflowRunId: null,
    name: pipeline.ref ? `Pipeline (${pipeline.ref})` : `Pipeline #${pipeline.id}`,
    status: pipeline.status,
    conclusion: pipeline.status,
    url: pipeline.web_url ?? null,
    detailsUrl: pipeline.web_url ?? null,
    output: null,
    annotations: [],
    failedJobs: [],
    truncated: false,
    pipeline: toPipelineDetails(pipeline),
  };
}

function toCurrentPullRequestStatus(
  mr: GitLabMergeRequest,
  approvals?: GitLabApprovals | null,
): CurrentPullRequestStatus {
  const { owner, name } = splitProjectPath(mr.references?.full);
  const projectPath = extractProjectPath(mr.references?.full);
  return {
    number: mr.iid,
    ...(owner ? { repoOwner: owner } : {}),
    ...(name ? { repoName: name } : {}),
    ...(projectPath ? { projectPath } : {}),
    url: mr.web_url,
    title: mr.title,
    state: mapMergeRequestState(mr.state),
    baseRefName: mr.target_branch,
    headRefName: mr.source_branch,
    isMerged: mr.state === "merged" || mr.merged_at != null,
    isDraft: mr.draft ?? mr.work_in_progress ?? false,
    mergeable: mapMergeable(mr),
    checks: [],
    checksStatus: mapPipelineChecksStatus(mr.head_pipeline?.status),
    reviewDecision: null,
    forgeSpecific: { forge: "gitlab", ...toGitLabStatusFacts(mr, approvals) },
  };
}

function isAuthFailureText(text: string): boolean {
  return /\b(401|unauthorized|not logged in|authentication failed|no token|invalid token)\b/i.test(
    text,
  );
}

function isNoMergeRequestText(text: string): boolean {
  return /no (open )?merge request|not found|no merge requests/i.test(text);
}

function normalizeGlabCommandError(
  error: unknown,
  context: { args: string[]; cwd: string },
): Error {
  return normalizeCliCommandError({
    error,
    args: context.args,
    cwd: context.cwd,
    commandName: "glab",
    timeoutMs: GLAB_COMMAND_TIMEOUT_MS,
    isAlreadyClassified: (candidate) =>
      candidate instanceof GlabAuthenticationError || candidate instanceof GlabCliMissingError,
    isCommandError: (candidate): candidate is GlabCommandError =>
      candidate instanceof GlabCommandError,
    isAuthFailureText,
    createAuthError: (stderr) => new GlabAuthenticationError({ stderr }),
    createMissingError: () => new GlabCliMissingError(),
    createCommandError: (params) => new GlabCommandError(params),
  });
}

function extractMergeRequestUrl(stdout: string): string | null {
  const match = stdout.match(/https?:\/\/\S+\/-\/merge_requests\/\d+/);
  return match ? match[0] : null;
}

function parseIidFromUrl(url: string): number | null {
  const match = url.match(/\/merge_requests\/(\d+)/);
  return match ? Number(match[1]) : null;
}

/**
 * Pipeline states where GitLab's "merge when pipeline succeeds" schedules the
 * merge instead of running it immediately. Mirrors the client-side auto-merge
 * policy (the PR pane only offers enable while a pipeline is in flight).
 */
const GITLAB_ACTIVE_PIPELINE_STATUS_SET = new Set<string>(GITLAB_ACTIVE_PIPELINE_STATUSES);

function parseOptionalTime(value: string | undefined): number {
  if (!value) {
    return 0;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Probe whether `host` is a GitLab instance by asking glab about its auth status
 * for that hostname (exit 0 => a configured GitLab instance, even for
 * self-managed hosts whose name carries no "gitlab" hint), then falling back to
 * GitLab's API marker header. The forge resolver uses this to detect
 * self-managed hosts the name heuristic can't classify.
 */
export async function probeGitLabHost(host: string): Promise<boolean> {
  const glabPath = await findExecutable("glab");
  if (glabPath) {
    try {
      await execCommand("glab", ["auth", "status", "--hostname", host], {
        envOverlay: GLAB_ENV,
        timeout: 10_000,
      });
      return true;
    } catch {
      // Do not treat auth failures as a positive probe: glab reports the same
      // unauthenticated message for arbitrary non-GitLab hosts.
    }
  }
  return probeGitLabHostByHttp(host);
}

export async function probeGitLabHostByHttp(
  host: string,
  fetchImpl: GitLabHostProbeFetch = globalThis.fetch,
): Promise<boolean> {
  if (!fetchImpl) {
    return false;
  }
  try {
    const url = new URL(`https://${host}/api/v4/version`);
    const response = await fetchImpl(url.toString(), {
      method: "GET",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(GITLAB_HOST_PROBE_TIMEOUT_MS),
    });
    if (response.headers.has("x-gitlab-meta")) {
      return true;
    }
    if (!response.ok) {
      return false;
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("application/json")) {
      return false;
    }
    const body = await response.json().catch(() => null);
    return isGitLabVersionResponseBody(body);
  } catch {
    return false;
  }
}

function isGitLabVersionResponseBody(body: unknown): boolean {
  const candidate = body as Record<string, unknown> | null;
  return (
    candidate !== null &&
    typeof candidate === "object" &&
    typeof candidate.version === "string" &&
    typeof candidate.revision === "string"
  );
}

function getGitlabStatusFacts(status: MergePullRequestOptions["status"]): GitLabStatusFacts | null {
  const forgeSpecific = status?.forgeSpecific;
  if (!forgeSpecific || forgeSpecific.forge !== "gitlab") {
    return null;
  }
  return forgeSpecific;
}

/**
 * Server-side guard for GitLab auto-merge: `glab mr merge --auto-merge` only
 * schedules the merge while a pipeline is active. Without one it merges on the
 * spot, so this is enforced at execution time as well as in UI policy.
 */
export function assertGitLabAutoMergeEnableReady(
  input: Pick<EnablePullRequestAutoMergeOptions, "status">,
): void {
  const gitlab = getGitlabStatusFacts(input.status);
  if (!gitlab) {
    throw new Error("GitLab auto-merge facts are unavailable for this merge request");
  }
  if (gitlab.mergeWhenPipelineSucceeds) {
    throw new Error("Auto-merge is already enabled for this merge request");
  }
  if (
    gitlab.pipelineStatus === null ||
    !GITLAB_ACTIVE_PIPELINE_STATUS_SET.has(gitlab.pipelineStatus)
  ) {
    throw new Error(
      "GitLab auto-merge requires an in-progress pipeline; without one the merge would run immediately",
    );
  }
}

/**
 * Server-side guard for a GitLab direct merge, mirroring the GitHub adapter's
 * assertDirectPullRequestMergeReady: refuse the merge unless GitLab reports the
 * MR as directly mergeable and auto-merge is not already scheduled. Enforced
 * here (not just in the UI policy) because the resolved status can go stale
 * between the client check and execution, and the RPC can be called directly.
 */
function assertGitLabDirectMergeReady(input: Pick<MergePullRequestOptions, "status">): void {
  const gitlab = getGitlabStatusFacts(input.status);
  if (!gitlab) {
    throw new Error("GitLab merge facts are unavailable for this merge request");
  }
  if (gitlab.mergeWhenPipelineSucceeds) {
    throw new Error("Direct merge is not available because auto-merge is already enabled");
  }
  if (gitlab.detailedMergeStatus !== "mergeable") {
    throw new Error("GitLab does not report this merge request as ready for direct merge");
  }
}

export function createGitLabService(options: CreateGitLabServiceOptions = {}): ForgeService {
  const runner = options.runner ?? runGlabCommand;
  const resolveGlab = options.resolveGlabPath ?? resolveGlabPath;
  const resolveRemoteUrl = options.resolveRemoteUrl ?? defaultResolveRemoteUrl;

  async function run(args: string[], runOptions: GlabCommandRunnerOptions): Promise<string> {
    const glabPath = await resolveGlab();
    if (!glabPath) {
      throw new GlabCliMissingError();
    }
    try {
      const result = await runner(args, runOptions);
      return result.stdout.trim();
    } catch (error) {
      throw normalizeGlabCommandError(error, { args, cwd: runOptions.cwd });
    }
  }

  // Centralize parse + validate so a malformed or empty glab payload surfaces as
  // a classified GlabCommandError (with args + cwd) instead of a raw
  // SyntaxError/ZodError that bypasses the Glab* error classification.
  async function runJson<T>(
    args: string[],
    runOptions: GlabCommandRunnerOptions,
    schema: z.ZodType<T>,
  ): Promise<T> {
    const stdout = await run(args, runOptions);
    return parseCliJsonOutput({
      commandName: "glab",
      args,
      cwd: runOptions.cwd,
      stdout,
      schema,
      createCommandError: (params) => new GlabCommandError(params),
    });
  }

  async function viewMergeRequest(cwd: string, ref: string): Promise<GitLabMergeRequest> {
    return runJson(["mr", "view", ref, "-F", "json"], { cwd }, GitLabMergeRequestSchema);
  }

  /**
   * Detects whether discussions exist beyond the first fetched page. The command
   * runner exposes no pagination headers, so instead of a bare `length >= 100`
   * (which falsely flags an exactly-full page as truncated) we probe for a single
   * discussion on the next page. Best-effort: if the probe fails we keep the
   * already-fetched notes and conservatively report truncation, since a full
   * first page means at least one page of discussions exists.
   */
  async function hasDiscussionsAfterFirstPage(
    cwd: string,
    projectPath: string,
    iid: number,
  ): Promise<boolean> {
    try {
      const probe = await runJson(
        [
          "api",
          `projects/${encodeURIComponent(projectPath)}/merge_requests/${iid}/discussions?per_page=1&page=${TIMELINE_PAGE_SIZE + 1}`,
        ],
        { cwd },
        z.array(GitLabDiscussionSchema),
      );
      return probe.length > 0;
    } catch {
      return true;
    }
  }

  /**
   * Fetches MR approval counts from the dedicated approvals endpoint, which
   * `glab mr view` omits. Best-effort: a host without the endpoint must not
   * break the MR status, so failures leave the counts at their fallback (0).
   */
  async function fetchApprovals(
    cwd: string,
    mr: GitLabMergeRequest,
  ): Promise<GitLabApprovals | null> {
    const projectPath = extractProjectPath(mr.references?.full);
    if (!projectPath) {
      return null;
    }
    try {
      return await runJson(
        ["api", `projects/${encodeURIComponent(projectPath)}/merge_requests/${mr.iid}/approvals`],
        { cwd },
        GitLabApprovalsSchema,
      );
    } catch {
      return null;
    }
  }

  async function runMergeRequestList(
    input: ListPullRequestsOptions,
  ): Promise<PullRequestSummary[]> {
    const args = ["mr", "list", "-F", "json"];
    const query = input.query?.trim();
    if (query) {
      args.push("--search", query);
    }
    if (typeof input.limit === "number") {
      args.push("-P", String(input.limit));
    }
    const mergeRequests = await runJson(
      args,
      { cwd: input.cwd },
      z.array(GitLabMergeRequestSchema),
    );
    return mergeRequests.map(toPullRequestSummary);
  }

  /**
   * `glab issue list` toggles JSON output with `-O/--output` (text|json); its
   * `-F/--output-format` flag means something else (details|ids|urls) and
   * silently falls back to the human-readable table for an unknown value. This
   * differs from `glab mr list`, where `-F/--output` is the JSON toggle. Using
   * the wrong flag here would emit a text table that fails JSON parsing.
   */
  async function runIssueList(input: ListIssuesOptions): Promise<IssueSummary[]> {
    const args = ["issue", "list", "-O", "json"];
    const query = input.query?.trim();
    if (query) {
      args.push("--search", query);
    }
    if (typeof input.limit === "number") {
      args.push("-P", String(input.limit));
    }
    const issues = await runJson(args, { cwd: input.cwd }, z.array(GitLabIssueSchema));
    return issues.map(toIssueSummary);
  }

  return {
    async isAuthenticated(input: { cwd: string } & ForgeReadOptions): Promise<boolean> {
      const glabPath = await resolveGlab();
      if (!glabPath) {
        return false;
      }
      const remoteUrl = await resolveRemoteUrl(input.cwd);
      const host = remoteUrl ? parseGitLabHostFromRemoteUrl(remoteUrl) : null;
      if (!host) {
        return false;
      }
      try {
        await runner(["auth", "status", "--hostname", host], { cwd: input.cwd });
        return true;
      } catch {
        return false;
      }
    },

    async getCurrentPullRequestStatus(input): Promise<CurrentPullRequestStatus | null> {
      try {
        const mr = await viewMergeRequest(input.cwd, input.headRef);
        const approvals = await fetchApprovals(input.cwd, mr);
        return toCurrentPullRequestStatus(mr, approvals);
      } catch (error) {
        if (error instanceof GlabCommandError && isNoMergeRequestText(error.stderr)) {
          return null;
        }
        throw error;
      }
    },

    async getPullRequest(input: GetPullRequestOptions): Promise<PullRequestSummary> {
      const mr = await viewMergeRequest(input.cwd, String(input.number));
      return toPullRequestSummary(mr);
    },

    async getPullRequestHeadRef(input: GetPullRequestOptions): Promise<string> {
      const mr = await viewMergeRequest(input.cwd, String(input.number));
      return mr.source_branch;
    },

    async getPullRequestCheckoutTarget(
      input: GetPullRequestOptions,
    ): Promise<PullRequestCheckoutTarget> {
      const mr = await viewMergeRequest(input.cwd, String(input.number));
      return {
        number: mr.iid,
        baseRefName: mr.target_branch,
        headRefName: mr.source_branch,
        checkoutRefs: [
          { remoteName: "origin", remoteRef: `refs/heads/${mr.source_branch}` },
          { remoteName: "origin", remoteRef: `refs/merge-requests/${mr.iid}/head` },
        ],
        headOwnerLogin: null,
        headRepositorySshUrl: null,
        headRepositoryUrl: null,
        isCrossRepository:
          mr.source_project_id !== undefined &&
          mr.source_project_id !== null &&
          mr.target_project_id !== undefined &&
          mr.target_project_id !== null &&
          mr.source_project_id !== mr.target_project_id,
      };
    },

    listPullRequests(input: ListPullRequestsOptions): Promise<PullRequestSummary[]> {
      return runMergeRequestList(input);
    },

    listIssues(input: ListIssuesOptions): Promise<IssueSummary[]> {
      return runIssueList(input);
    },

    async createPullRequest(input: CreatePullRequestOptions): Promise<PullRequestCreateResult> {
      const args = [
        "mr",
        "create",
        "--title",
        input.title,
        "--description",
        input.body ?? "",
        "--source-branch",
        input.head,
        "--target-branch",
        input.base,
        "--yes",
      ];
      const stdout = await run(args, { cwd: input.cwd });
      const url = extractMergeRequestUrl(stdout);
      if (!url) {
        throw new Error("GitLab merge request was created but no URL was returned by glab");
      }
      const number = parseIidFromUrl(url);
      if (number === null) {
        throw new Error(`GitLab merge request URL did not contain an iid: ${url}`);
      }
      return { url, number };
    },

    async mergePullRequest(input: MergePullRequestOptions): Promise<PullRequestMergeResult> {
      assertGitLabDirectMergeReady(input);
      // `--auto-merge=false` forces an immediate merge: without it glab's default
      // would schedule "merge when the pipeline succeeds" while a pipeline runs,
      // turning a direct merge into an auto-merge. Mirrors `gh pr merge` without
      // `--auto`. The pre-flight guard above stays — both are needed.
      const args = ["mr", "merge", String(input.prNumber), "--auto-merge=false", "--yes"];
      if (input.mergeMethod === "squash") {
        args.push("--squash");
      } else if (input.mergeMethod === "rebase") {
        args.push("--rebase");
      }
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
        const mr = await viewMergeRequest(input.cwd, String(input.prNumber));
        const projectPath = extractProjectPath(mr.references?.full);
        if (!projectPath) {
          return {
            ...identity,
            items: [],
            truncated: false,
            error: {
              kind: "not_found",
              message: "GitLab merge request project path is unavailable",
            },
          };
        }
        const discussions = await runJson(
          [
            "api",
            `projects/${encodeURIComponent(projectPath)}/merge_requests/${mr.iid}/discussions?per_page=${TIMELINE_PAGE_SIZE}`,
          ],
          { cwd: input.cwd },
          z.array(GitLabDiscussionSchema),
        );
        const items = discussions
          .flatMap((discussion) =>
            discussion.notes.map((note) => toTimelineComment(note, discussion, mr.web_url)),
          )
          .filter((item): item is PullRequestTimelineItem => item !== null)
          .sort(compareTimelineItems);
        const truncated =
          discussions.length >= TIMELINE_PAGE_SIZE
            ? await hasDiscussionsAfterFirstPage(input.cwd, projectPath, mr.iid)
            : false;
        return {
          ...identity,
          items,
          truncated,
          error: null,
        };
      } catch (error) {
        return { ...identity, items: [], truncated: false, error: mapGlabTimelineError(error) };
      }
    },

    async getCheckDetails(input: GetCheckDetailsOptions): Promise<CheckDetails> {
      const pipeline = await runJson(
        [
          "ci",
          "get",
          "--pipeline-id",
          String(input.checkRunId),
          "--with-job-details",
          "-F",
          "json",
        ],
        { cwd: input.cwd },
        GitLabPipelineDetailsSchema,
      );
      return toCheckDetails(pipeline);
    },

    async searchIssuesAndPrs(input: SearchIssuesAndPrsOptions): Promise<SearchResult> {
      if (input.force && !input.reason) {
        throw new Error("ForgeService forced read requires a reason");
      }

      const kinds = normalizeForgeSearchKinds(input.kinds);
      const shouldFetchIssues = kinds.includes("issue");
      const shouldFetchMergeRequests = kinds.includes("change_request");
      const [issuesResult, mergeRequestsResult] = await Promise.allSettled([
        shouldFetchIssues
          ? runIssueList({ cwd: input.cwd, query: input.query, limit: input.limit })
          : Promise.resolve(null),
        shouldFetchMergeRequests
          ? runMergeRequestList({ cwd: input.cwd, query: input.query, limit: input.limit })
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
            (result.reason instanceof GlabCliMissingError ||
              result.reason instanceof GlabAuthenticationError),
        );
      if (everyRequestRejectedForAuth) {
        const hasMissingCli = requestedResults.some(
          (result) => result.status === "rejected" && result.reason instanceof GlabCliMissingError,
        );
        return createUnavailableSearchResult(hasMissingCli ? "cli_missing" : "unauthenticated");
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
            ...(issue.projectPath ? { projectPath: issue.projectPath } : {}),
            baseRefName: null,
            headRefName: null,
            updatedAt: issue.updatedAt,
          });
        }
      }
      if (shouldFetchMergeRequests && mergeRequestsResult.status === "fulfilled") {
        for (const mergeRequest of mergeRequestsResult.value ?? []) {
          items.push({
            kind: "pr",
            number: mergeRequest.number,
            title: mergeRequest.title,
            url: mergeRequest.url,
            state: mergeRequest.state,
            body: mergeRequest.body,
            labels: mergeRequest.labels,
            ...(mergeRequest.projectPath ? { projectPath: mergeRequest.projectPath } : {}),
            baseRefName: mergeRequest.baseRefName,
            headRefName: mergeRequest.headRefName,
            updatedAt: mergeRequest.updatedAt,
          });
        }
      }
      items.sort(
        (left, right) => parseOptionalTime(right.updatedAt) - parseOptionalTime(left.updatedAt),
      );

      return {
        items,
        featuresEnabled: true,
        authState: "authenticated",
        githubFeaturesEnabled: true,
      };
    },

    async enablePullRequestAutoMerge(
      input: EnablePullRequestAutoMergeOptions,
    ): Promise<PullRequestAutoMergeResult> {
      // GitLab's auto-merge is "merge when pipeline succeeds": passing
      // `--auto-merge` while a pipeline is running schedules the merge instead
      // of performing it immediately. The merge strategy mirrors mergePullRequest.
      assertGitLabAutoMergeEnableReady({ status: input.status });
      const args = ["mr", "merge", String(input.prNumber), "--auto-merge", "--yes"];
      if (input.mergeMethod === "squash") {
        args.push("--squash");
      } else if (input.mergeMethod === "rebase") {
        args.push("--rebase");
      }
      await run(args, { cwd: input.cwd });
      return { success: true };
    },

    async disablePullRequestAutoMerge(
      input: DisablePullRequestAutoMergeOptions,
    ): Promise<PullRequestAutoMergeResult> {
      // `glab mr merge --auto-merge=false` would merge immediately rather than
      // cancel a scheduled auto-merge, so cancel via the REST endpoint instead.
      // The `:fullpath` placeholder resolves the project from the cwd's remote.
      await run(
        [
          "api",
          "--method",
          "POST",
          `projects/:fullpath/merge_requests/${input.prNumber}/cancel_merge_when_pipeline_succeeds`,
        ],
        { cwd: input.cwd },
      );
      return { success: true };
    },

    invalidate(_input: { cwd: string }): void {},
  };
}
