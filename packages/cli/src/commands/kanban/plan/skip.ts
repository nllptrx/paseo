import type { Command } from "commander";
import type { ListResult } from "../../../output/index.js";
import { runStepAction, type StepActionOptions, type StepRow } from "./step-action.js";

export async function runSkipCommand(
  planId: string,
  options: StepActionOptions,
  _command: Command,
): Promise<ListResult<StepRow>> {
  return runStepAction("skip", planId, options, "PLAN_STEP_SKIP_FAILED", "skip step");
}
