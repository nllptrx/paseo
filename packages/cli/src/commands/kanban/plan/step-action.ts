import type { ListResult, OutputSchema } from "../../../output/index.js";
import {
  connectKanbanClient,
  requireString,
  toKanbanCommandError,
  type PlanCommandOptions,
} from "./shared.js";
import type { Step } from "@getpaseo/protocol/kanban/types";

export interface StepActionOptions extends PlanCommandOptions {
  step?: string;
}

export interface StepRow {
  key: string;
  value: string;
}

const stepSchema: OutputSchema<StepRow> = {
  idField: "key",
  columns: [
    { header: "KEY", field: "key", width: 18 },
    { header: "VALUE", field: "value", width: 80 },
  ],
};

function toStepRows(step: Step): StepRow[] {
  return [
    { key: "StepId", value: step.id },
    { key: "StepName", value: step.name },
    { key: "Runs", value: `${step.runs.length}` },
    { key: "LastStatus", value: step.runs.at(-1)?.status ?? "none" },
  ];
}

export async function runStepAction(
  action: "run" | "retry" | "skip",
  planId: string,
  options: StepActionOptions,
  errorCode: string,
  errorLabel: string,
): Promise<ListResult<StepRow>> {
  const kanbanId = requireString(options.kanban, "--kanban");
  const stepId = requireString(options.step, "--step");
  const { client } = await connectKanbanClient(options.host);
  try {
    const request = {
      kanbanId,
      planId,
      stepId,
      ...(options.parent !== undefined ? { parentPlanId: options.parent } : {}),
    };
    const dispatch = {
      run: () => client.kanbanStepRun(request),
      retry: () => client.kanbanStepRetry(request),
      skip: () => client.kanbanStepSkip(request),
    } as const;
    const payload = await dispatch[action]();
    if (payload.error || !payload.step) {
      throw new Error(payload.error ?? `Step ${action} failed: ${stepId}`);
    }
    return {
      type: "list",
      data: toStepRows(payload.step),
      schema: stepSchema,
    };
  } catch (error) {
    throw toKanbanCommandError(errorCode, errorLabel, error);
  } finally {
    await client.close().catch(() => {});
  }
}
