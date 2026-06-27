import { createGitHubService } from "./github-service.js";
import type { ForgeService } from "./github-service.js";
import { createGitLabService } from "./gitlab-service.js";

/**
 * Open registry of forge adapters. A `forge` is a plain string key, so new
 * adapters (Gitea/Forgejo, Bitbucket, …) plug in here without touching the
 * call sites that depend on the registry.
 */
const FORGE_FACTORIES: Record<string, () => ForgeService> = {
  github: createGitHubService,
  gitlab: createGitLabService,
};

export function knownForgeIds(): string[] {
  return Object.keys(FORGE_FACTORIES);
}

export function isKnownForge(forge: string): boolean {
  return Object.hasOwn(FORGE_FACTORIES, forge);
}

/**
 * Build the adapter for a forge id, or null when the id is not registered.
 * Each call constructs a fresh adapter; callers that want a shared instance
 * (e.g. the resolver) cache it themselves.
 */
export function createForgeService(forge: string): ForgeService | null {
  const factory = FORGE_FACTORIES[forge];
  return factory ? factory() : null;
}
