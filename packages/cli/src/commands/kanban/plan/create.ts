import type { Command } from "commander";
import type { SingleResult } from "../../../output/index.js";
import { resolveProviderAndModel } from "../../../utils/provider-model.js";
import { columnsFor, planSchema, toPlanRow, type PlanRow } from "./schema.js";
import {
  connectKanbanClient,
  fetchKanban,
  requireString,
  toKanbanCommandError,
  type PlanCommandOptions,
} from "./shared.js";
import type { KanbanPlanCreateBody, StepInput } from "@getpaseo/protocol/kanban/rpc-schemas";
import type { StepTrigger, StepWorkspaceStrategy } from "@getpaseo/protocol/kanban/types";

export interface PlanCreateOptions extends PlanCommandOptions {
  column?: string;
  description?: string;
  nested?: boolean;
  stepName?: string;
  stepPrompt?: string;
  provider?: string;
  model?: string;
  mode?: string;
  thinking?: string;
  workspace?: string;
  trigger?: string;
}

function parseWorkspaceStrategy(value: string | undefined): StepWorkspaceStrategy {
  const trimmed = value?.trim() || "reuse_previous";
  if (trimmed === "reuse_previous" || trimmed === "worktree" || trimmed === "worktree_per_agent") {
    return { mode: trimmed };
  }
  if (trimmed.startsWith("existing:")) {
    const workspaceId = trimmed.slice("existing:".length).trim();
    if (!workspaceId) {
      throw { code: "INVALID_WORKSPACE", message: "existing:<workspaceId> cannot be empty" };
    }
    return { mode: "existing", workspaceId };
  }
  throw {
    code: "INVALID_WORKSPACE",
    message: `--workspace must be one of reuse_previous, worktree, worktree_per_agent, existing:<workspaceId> (got ${trimmed})`,
  };
}

function parseTrigger(value: string | undefined): StepTrigger {
  const trimmed = value?.trim() || "immediate";
  if (trimmed === "immediate" || trimmed === "manual") {
    return { type: trimmed };
  }
  throw {
    code: "INVALID_TRIGGER",
    message: `--trigger must be one of immediate, manual (got ${trimmed})`,
  };
}

function buildBody(options: PlanCreateOptions, title: string): KanbanPlanCreateBody {
  if (options.nested) {
    return { type: "nested_kanban" };
  }
  const prompt = options.stepPrompt?.trim();
  if (!prompt) {
    throw {
      code: "MISSING_STEP_PROMPT",
      message: "--step-prompt is required for workflow plans (or pass --nested)",
    };
  }
  const resolved = resolveProviderAndModel({ provider: options.provider, model: options.model });
  const modeId = options.mode?.trim();
  const thinkingOptionId = options.thinking?.trim();
  const step: StepInput = {
    name: options.stepName?.trim() || title,
    prompt,
    agents: [
      {
        provider: resolved.provider,
        ...(resolved.model ? { model: resolved.model } : {}),
        ...(modeId ? { modeId } : {}),
        ...(thinkingOptionId ? { thinkingOptionId } : {}),
      },
    ],
    completion: "all",
    workspace: parseWorkspaceStrategy(options.workspace),
    trigger: parseTrigger(options.trigger),
  };
  return { type: "workflow", steps: [step] };
}

export async function runCreateCommand(
  title: string,
  options: PlanCreateOptions,
  _command: Command,
): Promise<SingleResult<PlanRow>> {
  const trimmedTitle = title.trim();
  if (!trimmedTitle) {
    throw { code: "INVALID_TITLE", message: "Plan title cannot be empty" };
  }
  const body = buildBody(options, trimmedTitle);
  const kanbanId = requireString(options.kanban, "--kanban");
  const columnId = requireString(options.column, "--column");
  const { client } = await connectKanbanClient(options.host);
  try {
    const payload = await client.kanbanPlanCreate({
      kanbanId,
      columnId,
      title: trimmedTitle,
      body,
      ...(options.parent !== undefined ? { parentPlanId: options.parent } : {}),
      ...(options.description?.trim() ? { description: options.description.trim() } : {}),
    });
    if (payload.error || !payload.plan) {
      throw new Error(payload.error ?? "Plan creation failed");
    }
    const kanban = await fetchKanban(client, kanbanId);
    return {
      type: "single",
      data: toPlanRow(columnsFor(kanban, options.parent), payload.plan),
      schema: planSchema,
    };
  } catch (error) {
    throw toKanbanCommandError("PLAN_CREATE_FAILED", "create plan", error);
  } finally {
    await client.close().catch(() => {});
  }
}
