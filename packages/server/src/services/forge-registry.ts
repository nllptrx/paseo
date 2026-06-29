import { isGitHubHost, normalizeHost } from "@getpaseo/protocol/git-remote";
import { createGitHubService } from "./github-service.js";
import type { ForgeService } from "./forge-service.js";
import { createGiteaService, resolveGiteaFamilyForge } from "./gitea-service.js";
import { createGitLabService, probeGitLabHost } from "./gitlab-service.js";

export type ForgeServiceFactory = () => ForgeService;

export interface ForgeAdapterRegistration {
  createService: ForgeServiceFactory;
  matchesHost?: (host: string) => boolean;
  probeHost?: (host: string) => Promise<boolean>;
}

/**
 * Open composition boundary for forge adapters. Resolver code depends only on
 * these registration hooks, so a new adapter does not require another branch.
 */
export class ForgeRegistry {
  readonly #adapters = new Map<string, ForgeAdapterRegistration>();

  constructor(entries: Iterable<readonly [string, ForgeAdapterRegistration]> = []) {
    for (const [forge, adapter] of entries) {
      this.register(forge, adapter);
    }
  }

  register(forge: string, adapter: ForgeAdapterRegistration): () => void {
    const normalizedForge = parseForgeId(forge);
    if (!normalizedForge) {
      throw new Error(`Invalid forge adapter id: ${forge}`);
    }
    if (this.#adapters.has(normalizedForge)) {
      throw new Error(`Forge adapter already registered: ${normalizedForge}`);
    }
    this.#adapters.set(normalizedForge, adapter);
    return () => {
      if (this.#adapters.get(normalizedForge) === adapter) {
        this.#adapters.delete(normalizedForge);
      }
    };
  }

  ids(): string[] {
    return [...this.#adapters.keys()];
  }

  has(forge: string): boolean {
    const normalizedForge = parseForgeId(forge);
    return normalizedForge ? this.#adapters.has(normalizedForge) : false;
  }

  create(forge: string): ForgeService | null {
    const normalizedForge = parseForgeId(forge);
    if (!normalizedForge) {
      return null;
    }
    const adapter = this.#adapters.get(normalizedForge);
    return adapter ? adapter.createService() : null;
  }

  matchHost(host: string): string | null {
    const matches: string[] = [];
    for (const [forge, adapter] of this.#adapters) {
      if (adapter.matchesHost?.(host)) {
        matches.push(forge);
      }
    }
    if (matches.length > 1) {
      throw new Error(`Multiple forge adapters matched host ${host}: ${matches.join(", ")}`);
    }
    return matches[0] ?? null;
  }

  async probeHost(host: string): Promise<string | null> {
    const results = await Promise.all(
      [...this.#adapters].map(async ([forge, adapter]) => {
        if (!adapter.probeHost) {
          return null;
        }
        return (await adapter.probeHost(host)) ? forge : null;
      }),
    );
    const matches = results.filter((forge): forge is string => forge !== null);
    if (matches.length > 1) {
      throw new Error(`Multiple forge adapters recognized host ${host}: ${matches.join(", ")}`);
    }
    return matches[0] ?? null;
  }
}

function parseForgeId(forge: string): string | null {
  const normalized = forge.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9._-]*$/.test(normalized) ? normalized : null;
}

export const defaultForgeRegistry = new ForgeRegistry([
  ["github", { createService: createGitHubService, matchesHost: isGitHubHost }],
  [
    "gitlab",
    {
      createService: createGitLabService,
      matchesHost: (host) => normalizeHost(host) === "gitlab.com",
      probeHost: probeGitLabHost,
    },
  ],
  [
    "gitea",
    {
      createService: createGiteaService,
      matchesHost: (host) => normalizeHost(host) === "gitea.com",
      probeHost: async (host) => (await resolveGiteaFamilyForge(host)) === "gitea",
    },
  ],
  [
    "forgejo",
    {
      createService: createGiteaService,
      probeHost: async (host) => (await resolveGiteaFamilyForge(host)) === "forgejo",
    },
  ],
  [
    "codeberg",
    {
      createService: createGiteaService,
      matchesHost: (host) => normalizeHost(host) === "codeberg.org",
    },
  ],
]);

/** Register an adapter without changing resolver or protocol code. */
export function registerForgeAdapter(forge: string, adapter: ForgeAdapterRegistration): () => void {
  return defaultForgeRegistry.register(forge, adapter);
}

export function knownForgeIds(): string[] {
  return defaultForgeRegistry.ids();
}

export function isKnownForge(forge: string): boolean {
  return defaultForgeRegistry.has(forge);
}

export function createForgeService(forge: string): ForgeService | null {
  return defaultForgeRegistry.create(forge);
}

export function forgeForRegisteredHost(host: string): string | null {
  return defaultForgeRegistry.matchHost(host);
}

export function probeRegisteredForgeHost(host: string): Promise<string | null> {
  return defaultForgeRegistry.probeHost(host);
}
