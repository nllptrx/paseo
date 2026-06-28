import type { ForgeService, PullRequestCheckoutTarget } from "../services/github-service.js";
import type { WorktreeSource } from "../utils/worktree.js";

export type WorktreeCreationIntent = WorktreeSource;

export type ResolveWorktreeCreationIntentInput =
  | {
      worktreeSlug: string;
      branchName?: string;
      refName?: string;
      action?: "branch-off";
      githubPrNumber?: undefined;
    }
  | {
      worktreeSlug?: string;
      branchName?: string;
      refName?: string;
      action: "checkout";
      githubPrNumber?: number;
    }
  | {
      worktreeSlug?: string;
      branchName?: string;
      refName?: string;
      action?: undefined;
      githubPrNumber: number;
    };

export interface ResolveWorktreeCreationIntentDeps {
  forge: string;
  forgeService: ForgeService;
  resolveDefaultBranch: (repoRoot: string) => Promise<string>;
}

export class MissingCheckoutTargetError extends Error {
  readonly action = "checkout";

  constructor() {
    super('action "checkout" requires refName or githubPrNumber');
    this.name = "MissingCheckoutTargetError";
  }
}

export class UnsupportedForgeCheckoutTargetError extends Error {
  readonly forge: string;

  constructor(forge: string) {
    super(`Checkout from change request is not supported for ${forge} yet`);
    this.name = "UnsupportedForgeCheckoutTargetError";
    this.forge = forge;
  }
}

export async function resolveWorktreeCreationIntent(
  input: ResolveWorktreeCreationIntentInput,
  repoRoot: string,
  deps: ResolveWorktreeCreationIntentDeps,
): Promise<WorktreeCreationIntent> {
  if (input.action === "branch-off") {
    return {
      kind: "branch-off",
      baseBranch: input.refName?.trim() || (await resolveDefaultBranch(repoRoot, deps)),
      branchName: input.branchName ?? input.worktreeSlug,
    };
  }

  if (input.action === "checkout") {
    if (input.githubPrNumber !== undefined) {
      return resolvePrCheckoutIntent({
        refName: input.refName,
        githubPrNumber: input.githubPrNumber,
        repoRoot,
        deps,
      });
    }

    const branchName = input.refName?.trim();
    if (branchName) {
      return {
        kind: "checkout-branch",
        branchName,
      };
    }

    throw new MissingCheckoutTargetError();
  }

  if (input.githubPrNumber !== undefined) {
    return resolvePrCheckoutIntent({
      refName: input.refName,
      githubPrNumber: input.githubPrNumber,
      repoRoot,
      deps,
    });
  }

  if (input.refName?.trim()) {
    return {
      kind: "branch-off",
      baseBranch: input.refName.trim(),
      branchName: input.branchName ?? input.worktreeSlug,
    };
  }

  return {
    kind: "branch-off",
    baseBranch: await resolveDefaultBranch(repoRoot, deps),
    branchName: input.branchName ?? input.worktreeSlug,
  };
}

interface PrCheckoutIntentParams {
  refName?: string;
  githubPrNumber: number;
  repoRoot: string;
  deps: ResolveWorktreeCreationIntentDeps;
}

async function resolvePrCheckoutIntent(
  params: PrCheckoutIntentParams,
): Promise<WorktreeCreationIntent> {
  if (params.deps.forge === "github") {
    return resolveGitHubPrCheckoutIntent(params);
  }
  return resolveForgePrCheckoutIntent(params);
}

async function resolveForgePrCheckoutIntent(
  params: PrCheckoutIntentParams,
): Promise<Extract<WorktreeCreationIntent, { kind: "checkout-branch" }>> {
  const checkoutTarget = await resolvePrCheckoutTarget(params);
  if (checkoutTarget?.isCrossRepository) {
    throw new UnsupportedForgeCheckoutTargetError(params.deps.forge);
  }
  const headRef = await resolvePrHeadRef({
    refName: params.refName,
    githubPrNumber: params.githubPrNumber,
    checkoutTarget,
    repoRoot: params.repoRoot,
    deps: params.deps,
  });

  return {
    kind: "checkout-branch",
    branchName: headRef,
  };
}

async function resolveGitHubPrCheckoutIntent(
  params: PrCheckoutIntentParams,
): Promise<Extract<WorktreeCreationIntent, { kind: "checkout-github-pr" }>> {
  const checkoutTarget = await resolvePrCheckoutTarget(params);
  const headRef = await resolvePrHeadRef({
    refName: params.refName,
    githubPrNumber: params.githubPrNumber,
    checkoutTarget,
    repoRoot: params.repoRoot,
    deps: params.deps,
  });
  const baseRefName =
    checkoutTarget?.baseRefName?.trim() ||
    (await resolveDefaultBranch(params.repoRoot, params.deps));
  const localBranchName = buildGitHubPrLocalBranchName({ headRef, checkoutTarget });
  const pushRemoteUrl = checkoutTarget?.isCrossRepository
    ? checkoutTarget.headRepositorySshUrl || checkoutTarget.headRepositoryUrl || undefined
    : undefined;
  const trackOriginHead = checkoutTarget ? !checkoutTarget.isCrossRepository : false;

  return {
    kind: "checkout-github-pr",
    githubPrNumber: params.githubPrNumber,
    headRef,
    baseRefName,
    ...(localBranchName !== headRef ? { localBranchName } : {}),
    ...(pushRemoteUrl ? { pushRemoteUrl } : {}),
    ...(trackOriginHead ? { trackOriginHead } : {}),
  };
}

async function resolvePrCheckoutTarget(params: {
  githubPrNumber: number;
  repoRoot: string;
  deps: ResolveWorktreeCreationIntentDeps;
}): Promise<PullRequestCheckoutTarget | null> {
  if (!params.deps.forgeService.getPullRequestCheckoutTarget) {
    if (params.deps.forge === "github") {
      return null;
    }
    throw new UnsupportedForgeCheckoutTargetError(params.deps.forge);
  }
  return params.deps.forgeService.getPullRequestCheckoutTarget({
    cwd: params.repoRoot,
    number: params.githubPrNumber,
  });
}

async function resolveDefaultBranch(
  repoRoot: string,
  deps: ResolveWorktreeCreationIntentDeps,
): Promise<string> {
  const baseBranch = await deps.resolveDefaultBranch(repoRoot);
  if (!baseBranch) {
    throw new Error("Unable to resolve repository default branch");
  }
  return baseBranch;
}

async function resolvePrHeadRef(params: {
  refName?: string;
  githubPrNumber: number;
  checkoutTarget?: PullRequestCheckoutTarget | null;
  repoRoot: string;
  deps: ResolveWorktreeCreationIntentDeps;
}): Promise<string> {
  const trimmedRefName = params.refName?.trim();
  if (trimmedRefName) {
    return trimmedRefName;
  }
  const checkoutTargetHeadRef = params.checkoutTarget?.headRefName.trim();
  if (checkoutTargetHeadRef) {
    return checkoutTargetHeadRef;
  }
  return params.deps.forgeService.getPullRequestHeadRef({
    cwd: params.repoRoot,
    number: params.githubPrNumber,
  });
}

function buildGitHubPrLocalBranchName(params: {
  headRef: string;
  checkoutTarget: PullRequestCheckoutTarget | null;
}): string {
  const owner = params.checkoutTarget?.isCrossRepository
    ? normalizeGitHubOwnerForBranch(params.checkoutTarget.headOwnerLogin)
    : null;
  return owner ? `${owner}/${params.headRef}` : params.headRef;
}

function normalizeGitHubOwnerForBranch(owner: string | null): string | null {
  const normalized = owner?.trim().toLowerCase() ?? "";
  return /^[a-z0-9-]+$/.test(normalized) ? normalized : null;
}
