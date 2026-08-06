import { connectToDaemon, getDaemonHost } from "../../utils/client.js";
import type { CommandError, CommandOptions } from "../../output/index.js";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { KanbanPlan, NestedPlan, StoredKanban } from "@getpaseo/protocol/kanban/types";

export interface KanbanCommandOptions extends CommandOptions {
  host?: string;
}

export async function connectKanbanClient(
  host: string | undefined,
): Promise<{ client: DaemonClient; host: string }> {
  const resolvedHost = getDaemonHost({ host });
  try {
    const client = await connectToDaemon({ host });
    return { client, host: resolvedHost };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw {
      code: "DAEMON_NOT_RUNNING",
      message: `Cannot connect to daemon at ${resolvedHost}: ${message}`,
      details: "Start the daemon with: paseo daemon start",
    } satisfies CommandError;
  }
}

export function requireString(value: string | undefined, flag: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw {
      code: "MISSING_OPTION",
      message: `${flag} is required`,
    } satisfies CommandError;
  }
  return trimmed;
}

export function requireNonNegativeInt(value: string | undefined, flag: string): number {
  const parsed = Number.parseInt(requireString(value, flag), 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw {
      code: "INVALID_INTEGER",
      message: `${flag} must be a non-negative integer`,
    } satisfies CommandError;
  }
  return parsed;
}

export function toKanbanCommandError(code: string, action: string, error: unknown): CommandError {
  if (error && typeof error === "object" && "code" in error) {
    return error as CommandError;
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    code,
    message: `Failed to ${action}: ${message}`,
  };
}

export async function resolveProjectId(
  client: DaemonClient,
  options: { project?: string; cwd?: string },
): Promise<string> {
  const explicit = options.project?.trim();
  if (explicit) {
    return explicit;
  }
  const cwd = options.cwd?.trim() || process.cwd();
  const payload = await client.addProject(cwd);
  if (payload.error || !payload.project) {
    throw new Error(payload.error ?? `Failed to resolve project for ${cwd}`);
  }
  return payload.project.projectId;
}

export async function fetchKanban(client: DaemonClient, kanbanId: string): Promise<StoredKanban> {
  const payload = await client.kanbanGet(kanbanId);
  if (payload.error || !payload.kanban) {
    throw new Error(payload.error ?? `Kanban not found: ${kanbanId}`);
  }
  return payload.kanban;
}

export function findPlan(
  kanban: StoredKanban,
  planId: string,
  parentPlanId: string | null | undefined,
): KanbanPlan | NestedPlan {
  if (parentPlanId) {
    const parent = kanban.plans[parentPlanId];
    if (!parent || parent.body.type !== "nested_kanban") {
      throw new Error(`Nested kanban plan not found: ${parentPlanId}`);
    }
    const nested = parent.body.plans[planId];
    if (!nested) {
      throw new Error(`Plan not found: ${planId}`);
    }
    return nested;
  }
  const plan = kanban.plans[planId];
  if (!plan) {
    throw new Error(`Plan not found: ${planId}`);
  }
  return plan;
}
