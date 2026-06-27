import { runGitCommand } from "../utils/run-git-command.js";
import type { ForgeService } from "./forge-service.js";
import {
  createForgeService,
  forgeForRegisteredHost,
  probeRegisteredForgeHost,
} from "./forge-registry.js";

export interface ForgeResolution {
  /** Registered forge id, e.g. "github" or "gitlab". */
  forge: string;
  /** Remote host the cwd resolves to, e.g. "github.com" or "gitlab.example.com". */
  host: string;
  /** Adapter for {@link forge}, shared across resolutions of the same forge. */
  service: ForgeService;
}

/** Probe a host for a forge id when the name heuristic is inconclusive. */
export type ForgeHostProbe = (host: string) => Promise<string | null>;

export interface CreateForgeResolverOptions {
  resolveRemoteUrl?: (cwd: string) => Promise<string | null>;
  createService?: (forge: string) => ForgeService | null;
  probeForge?: ForgeHostProbe;
}

export interface ForgeResolver {
  /** Resolve the forge for a working directory, or null when none applies. */
  resolve(cwd: string): Promise<ForgeResolution | null>;
  /** Resolve from a known origin remote URL using only the name heuristic + probe cache. */
  resolveFromRemoteUrl(remoteUrl: string | null): ForgeResolution | null;
  /** Resolve from a known origin remote URL, running the per-host probe when needed. */
  resolveFromRemoteUrlAsync(remoteUrl: string | null): Promise<ForgeResolution | null>;
}

// A positive probe (host IS a known forge) is cached permanently; a negative one
// expires so a CLI installed/authenticated later is picked up without a restart.
const NEGATIVE_PROBE_TTL_MS = 60_000;

export function parseRemoteHost(url: string): string | null {
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

/** Map a remote host through the matchers owned by registered adapters. */
export function forgeForHost(host: string): string | null {
  return forgeForRegisteredHost(host);
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

export function createForgeResolver(options: CreateForgeResolverOptions = {}): ForgeResolver {
  const resolveRemoteUrl = options.resolveRemoteUrl ?? defaultResolveRemoteUrl;
  const create = options.createService ?? createForgeService;
  const probeForge = options.probeForge ?? probeRegisteredForgeHost;
  const services = new Map<string, ForgeService>();
  // Cache the per-host probe result so the synchronous resolveFromRemoteUrl can
  // reuse a forge discovered by an earlier async resolve. Positive results are
  // permanent; negative ones expire (NEGATIVE_PROBE_TTL_MS) so a CLI installed
  // or authenticated later is picked up without a daemon restart.
  const probedForgeByHost = new Map<string, { forge: string | null; expiresAt: number | null }>();
  // Coalesce concurrent probes of the same host so "never re-probe" holds under
  // concurrency: callers racing on the same host await one shared probe.
  const inFlightProbes = new Map<string, Promise<string | null>>();

  function readFreshProbe(host: string): string | null | undefined {
    const entry = probedForgeByHost.get(host);
    if (!entry) {
      return undefined;
    }
    if (entry.expiresAt !== null && Date.now() >= entry.expiresAt) {
      probedForgeByHost.delete(host);
      return undefined;
    }
    return entry.forge;
  }

  function buildResolution(forge: string, host: string): ForgeResolution | null {
    let service = services.get(forge);
    if (!service) {
      const created = create(forge);
      if (!created) {
        return null;
      }
      service = created;
      services.set(forge, service);
    }
    return { forge, host, service };
  }

  async function probeHostForge(host: string): Promise<string | null> {
    const cached = readFreshProbe(host);
    if (cached !== undefined) {
      return cached;
    }
    const existing = inFlightProbes.get(host);
    if (existing) {
      return existing;
    }
    const pending = (async () => {
      try {
        const probed = await probeForge(host);
        probedForgeByHost.set(host, {
          forge: probed,
          expiresAt: probed === null ? Date.now() + NEGATIVE_PROBE_TTL_MS : null,
        });
        return probed;
      } finally {
        inFlightProbes.delete(host);
      }
    })();
    inFlightProbes.set(host, pending);
    return pending;
  }

  function resolveFromRemoteUrl(remoteUrl: string | null): ForgeResolution | null {
    if (!remoteUrl) {
      return null;
    }
    const host = parseRemoteHost(remoteUrl);
    if (!host) {
      return null;
    }
    const forge = forgeForHost(host) ?? readFreshProbe(host) ?? null;
    if (!forge) {
      return null;
    }
    return buildResolution(forge, host);
  }

  async function resolveFromRemoteUrlAsync(
    remoteUrl: string | null,
  ): Promise<ForgeResolution | null> {
    if (!remoteUrl) {
      return null;
    }
    const host = parseRemoteHost(remoteUrl);
    if (!host) {
      return null;
    }
    const forge = forgeForHost(host) ?? (await probeHostForge(host));
    if (!forge) {
      return null;
    }
    return buildResolution(forge, host);
  }

  return {
    resolveFromRemoteUrl,
    resolveFromRemoteUrlAsync,
    async resolve(cwd: string): Promise<ForgeResolution | null> {
      return resolveFromRemoteUrlAsync(await resolveRemoteUrl(cwd));
    },
  };
}
