import type { AgentManager } from "./agent-manager.js";
import type { AgentStorage } from "./agent-storage.js";

export type ResolveAgentIdentifierResult =
  | { ok: true; agentId: string }
  | { ok: false; error: string };

/**
 * Resolves a user-typed agent identifier (full id, id prefix, or custom title) to a
 * canonical agent id. Shared by the session chat/post mention fanout and the
 * send_orchestrator_message MCP tool so the two surfaces never drift on matching rules.
 */
export async function resolveAgentIdentifier(params: {
  agentStorage: Pick<AgentStorage, "list">;
  agentManager: Pick<AgentManager, "listAgents">;
  identifier: string;
}): Promise<ResolveAgentIdentifierResult> {
  const trimmed = params.identifier.trim();
  if (!trimmed) {
    return { ok: false, error: "Agent identifier cannot be empty" };
  }

  const stored = await params.agentStorage.list();
  const storedRecords = stored.filter((record) => !record.internal);
  const knownIds = new Set<string>();
  for (const record of storedRecords) {
    knownIds.add(record.id);
  }
  for (const agent of params.agentManager.listAgents()) {
    knownIds.add(agent.id);
  }

  if (knownIds.has(trimmed)) {
    return { ok: true, agentId: trimmed };
  }

  const prefixMatches = Array.from(knownIds).filter((id) => id.startsWith(trimmed));
  if (prefixMatches.length === 1) {
    return { ok: true, agentId: prefixMatches[0] };
  }
  if (prefixMatches.length > 1) {
    return {
      ok: false,
      error: `Agent identifier "${trimmed}" is ambiguous (${prefixMatches
        .slice(0, 5)
        .map((id) => id.slice(0, 8))
        .join(", ")}${prefixMatches.length > 5 ? ", …" : ""})`,
    };
  }

  const titleMatches = storedRecords.filter((record) => record.title === trimmed);
  if (titleMatches.length === 1) {
    return { ok: true, agentId: titleMatches[0].id };
  }
  if (titleMatches.length > 1) {
    return {
      ok: false,
      error: `Agent title "${trimmed}" is ambiguous (${titleMatches
        .slice(0, 5)
        .map((r) => r.id.slice(0, 8))
        .join(", ")}${titleMatches.length > 5 ? ", …" : ""})`,
    };
  }

  return { ok: false, error: `Agent not found: ${trimmed}` };
}
