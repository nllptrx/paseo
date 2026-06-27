import { z } from "zod";
import { findExecutable } from "../executable-resolution/executable-resolution.js";
import { runGitCommand } from "../utils/run-git-command.js";
import { execCommand } from "../utils/spawn.js";
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
  PullRequestAutoMergeResult,
  PullRequestChecksStatus,
  PullRequestCreateResult,
  PullRequestMergeable,
  PullRequestMergeResult,
  PullRequestSummary,
  PullRequestTimeline,
  SearchIssuesAndPrsOptions,
  SearchResult,
} from "./forge-service.js";

const GLAB_ENV = {
  GIT_TERMINAL_PROMPT: "0",
  GLAB_CHECK_UPDATE: "0",
} as const;

const GLAB_COMMAND_TIMEOUT_MS = 30_000;

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

const GitLabPipelineSchema = z.object({ status: z.string().optional() }).passthrough();

const GitLabMergeRequestSchema = z
  .object({
    iid: z.number(),
    title: z.string(),
    web_url: z.string(),
    state: z.string(),
    source_branch: z.string(),
    target_branch: z.string(),
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
  })
  .passthrough();

type GitLabMergeRequest = z.infer<typeof GitLabMergeRequestSchema>;
type GitLabIssue = z.infer<typeof GitLabIssueSchema>;

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
  return {
    number: mr.iid,
    title: mr.title,
    url: mr.web_url,
    state: mapMergeRequestState(mr.state),
    body: mr.description ?? null,
    baseRefName: mr.target_branch,
    headRefName: mr.source_branch,
    labels: mr.labels ?? [],
    updatedAt: mr.updated_at ?? "",
  };
}

function toIssueSummary(issue: GitLabIssue): IssueSummary {
  return {
    number: issue.iid,
    title: issue.title,
    url: issue.web_url,
    state: issue.state,
    body: issue.description ?? null,
    labels: issue.labels ?? [],
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

function toGitLabStatusFacts(mr: GitLabMergeRequest): GitLabStatusFacts {
  return {
    detailedMergeStatus: mr.detailed_merge_status ?? null,
    hasConflicts: mr.has_conflicts ?? false,
    blockingDiscussionsResolved: mr.blocking_discussions_resolved ?? true,
    approvalsRequired: mr.approvals_required ?? 0,
    approvalsGiven: mr.approvals_given ?? 0,
    pipelineStatus: mr.head_pipeline?.status ?? null,
    mergeWhenPipelineSucceeds: mr.merge_when_pipeline_succeeds ?? false,
  };
}

function toCurrentPullRequestStatus(mr: GitLabMergeRequest): CurrentPullRequestStatus {
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
    forgeSpecific: { forge: "gitlab", ...toGitLabStatusFacts(mr) },
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

function bufferOrStringToString(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value instanceof Buffer) {
    return value.toString("utf8");
  }
  return "";
}

function normalizeGlabCommandError(
  error: unknown,
  context: { args: string[]; cwd: string },
): Error {
  if (error instanceof GlabAuthenticationError || error instanceof GlabCliMissingError) {
    return error;
  }
  if (error instanceof GlabCommandError) {
    if (isAuthFailureText(error.stderr)) {
      return new GlabAuthenticationError({ stderr: error.stderr });
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
    return new GlabCliMissingError();
  }
  const stderr = bufferOrStringToString(failure.stderr);
  const message = failure.message ?? "";
  if (isAuthFailureText(stderr) || isAuthFailureText(message)) {
    return new GlabAuthenticationError({ stderr });
  }
  if (failure.killed === true) {
    return new GlabCommandError({
      args: context.args,
      cwd: context.cwd,
      exitCode: null,
      stderr:
        stderr ||
        `glab was terminated before completing (timed out after ${GLAB_COMMAND_TIMEOUT_MS}ms or exceeded the output limit)`,
    });
  }
  return new GlabCommandError({
    args: context.args,
    cwd: context.cwd,
    exitCode: typeof failure.code === "number" ? failure.code : null,
    stderr: stderr || message,
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

function notSupported(feature: string): never {
  throw new Error(`${feature} is not supported on GitLab yet`);
}

/**
 * Probe whether `host` is a GitLab instance by asking glab about its auth status
 * for that hostname (exit 0 => a configured GitLab instance, even for
 * self-managed hosts whose name carries no "gitlab" hint). Returns false when
 * glab is absent or the host isn't a known GitLab instance. The forge resolver
 * uses this to detect self-managed hosts the name heuristic can't classify.
 */
export async function probeGitLabHost(host: string): Promise<boolean> {
  const glabPath = await findExecutable("glab");
  if (!glabPath) {
    return false;
  }
  try {
    await execCommand("glab", ["auth", "status", "--hostname", host], {
      envOverlay: GLAB_ENV,
      timeout: 10_000,
    });
    return true;
  } catch {
    return false;
  }
}

function getGitlabStatusFacts(status: MergePullRequestOptions["status"]): GitLabStatusFacts | null {
  const forgeSpecific = status?.forgeSpecific;
  if (!forgeSpecific || forgeSpecific.forge !== "gitlab") {
    return null;
  }
  return forgeSpecific;
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
    let data: unknown;
    try {
      data = JSON.parse(stdout);
    } catch {
      throw new GlabCommandError({
        args,
        cwd: runOptions.cwd,
        exitCode: null,
        stderr: `glab did not return valid JSON (${stdout.length} bytes)`,
      });
    }
    const parsed = schema.safeParse(data);
    if (!parsed.success) {
      throw new GlabCommandError({
        args,
        cwd: runOptions.cwd,
        exitCode: null,
        stderr: `glab JSON did not match the expected schema: ${parsed.error.message}`,
      });
    }
    return parsed.data;
  }

  async function viewMergeRequest(cwd: string, ref: string): Promise<GitLabMergeRequest> {
    return runJson(["mr", "view", ref, "-F", "json"], { cwd }, GitLabMergeRequestSchema);
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
        return toCurrentPullRequestStatus(mr);
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

    async listPullRequests(input: ListPullRequestsOptions): Promise<PullRequestSummary[]> {
      const args = ["mr", "list", "-F", "json"];
      if (typeof input.limit === "number") {
        args.push("-P", String(input.limit));
      }
      const mergeRequests = await runJson(
        args,
        { cwd: input.cwd },
        z.array(GitLabMergeRequestSchema),
      );
      return mergeRequests.map(toPullRequestSummary);
    },

    async listIssues(input: ListIssuesOptions): Promise<IssueSummary[]> {
      const args = ["issue", "list", "-F", "json"];
      if (typeof input.limit === "number") {
        args.push("-P", String(input.limit));
      }
      const issues = await runJson(args, { cwd: input.cwd }, z.array(GitLabIssueSchema));
      return issues.map(toIssueSummary);
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

    getPullRequestTimeline(_input: GetPullRequestTimelineOptions): Promise<PullRequestTimeline> {
      return notSupported("Merge request timeline");
    },

    getGitHubCheckDetails(_input: GetCheckDetailsOptions): Promise<CheckDetails> {
      return notSupported("Pipeline check details");
    },

    searchIssuesAndPrs(_input: SearchIssuesAndPrsOptions): Promise<SearchResult> {
      return notSupported("Issue and merge request search");
    },

    enablePullRequestAutoMerge(
      _input: EnablePullRequestAutoMergeOptions,
    ): Promise<PullRequestAutoMergeResult> {
      return notSupported("Auto-merge");
    },

    disablePullRequestAutoMerge(
      _input: DisablePullRequestAutoMergeOptions,
    ): Promise<PullRequestAutoMergeResult> {
      return notSupported("Auto-merge");
    },

    invalidate(_input: { cwd: string }): void {},
  };
}
