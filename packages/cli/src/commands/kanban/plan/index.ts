import { Command } from "commander";
import { withOutput } from "../../../output/index.js";
import { addJsonAndDaemonHostOptions } from "../../../utils/command-options.js";
import { runLsCommand } from "./ls.js";
import { runInspectCommand } from "./inspect.js";
import { runCreateCommand } from "./create.js";
import { runMoveCommand } from "./move.js";
import { runRunCommand } from "./run.js";
import { runRetryCommand } from "./retry.js";
import { runSkipCommand } from "./skip.js";
import { runLogsCommand } from "./logs.js";

function addKanbanScopeOptions<T extends Command>(command: T): T {
  return command
    .requiredOption("--kanban <id>", "Kanban ID")
    .option("--parent <planId>", "Parent plan ID (for plans inside a nested kanban)") as T;
}

export function createPlanCommand(): Command {
  const plan = new Command("plan").description("Manage plans on a kanban");

  addJsonAndDaemonHostOptions(
    addKanbanScopeOptions(plan.command("ls").description("List plans on a kanban")),
  ).action(withOutput(runLsCommand));

  addJsonAndDaemonHostOptions(
    addKanbanScopeOptions(
      plan.command("inspect").description("Inspect a plan").argument("<id>", "Plan ID"),
    ),
  ).action(withOutput(runInspectCommand));

  addJsonAndDaemonHostOptions(
    addKanbanScopeOptions(
      plan
        .command("create")
        .description("Create a plan on a kanban")
        .argument("<title>", "Plan title")
        .requiredOption("--column <columnId>", "Column ID to place the plan in")
        .option("--description <text>", "Plan description")
        .option("--nested", "Create a nested kanban plan instead of a workflow")
        .option("--step-name <name>", "Name for the initial workflow step")
        .option("--step-prompt <text>", "Prompt for the initial workflow step")
        .option(
          "--provider <provider>",
          "Agent provider, or provider/model (e.g. codex or codex/gpt-5.4)",
        )
        .option("--model <model>", "Agent model")
        .option(
          "--mode <mode>",
          "Provider-specific mode (e.g. claude bypassPermissions, opencode build)",
        )
        .option("--thinking <id>", "Thinking option ID")
        .option(
          "--workspace <strategy>",
          "Workspace strategy: reuse_previous, worktree, worktree_per_agent, existing:<workspaceId>",
        )
        .option("--trigger <type>", "Step trigger: immediate or manual"),
    ),
  ).action(withOutput(runCreateCommand));

  addJsonAndDaemonHostOptions(
    addKanbanScopeOptions(
      plan
        .command("move")
        .description("Move a plan to a column and position")
        .argument("<id>", "Plan ID")
        .requiredOption("--column <columnId>", "Destination column ID")
        .requiredOption("--index <n>", "Position within the column"),
    ),
  ).action(withOutput(runMoveCommand));

  addJsonAndDaemonHostOptions(
    addKanbanScopeOptions(
      plan
        .command("run")
        .description("Run a workflow step")
        .argument("<id>", "Plan ID")
        .requiredOption("--step <stepId>", "Step ID"),
    ),
  ).action(withOutput(runRunCommand));

  addJsonAndDaemonHostOptions(
    addKanbanScopeOptions(
      plan
        .command("retry")
        .description("Retry a workflow step")
        .argument("<id>", "Plan ID")
        .requiredOption("--step <stepId>", "Step ID"),
    ),
  ).action(withOutput(runRetryCommand));

  addJsonAndDaemonHostOptions(
    addKanbanScopeOptions(
      plan
        .command("skip")
        .description("Skip a workflow step")
        .argument("<id>", "Plan ID")
        .requiredOption("--step <stepId>", "Step ID"),
    ),
  ).action(withOutput(runSkipCommand));

  addJsonAndDaemonHostOptions(
    addKanbanScopeOptions(
      plan
        .command("logs")
        .description("Show step run history for a plan")
        .argument("<id>", "Plan ID")
        .option("--step <stepId>", "Filter to a single step"),
    ),
  ).action(withOutput(runLogsCommand));

  return plan;
}
