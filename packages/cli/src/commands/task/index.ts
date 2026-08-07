import { Command } from "commander";
import { withOutput } from "../../output/index.js";
import { addJsonAndDaemonHostOptions } from "../../utils/command-options.js";
import { runCreateCommand } from "./create.js";
import { runLsCommand } from "./ls.js";
import { runMoveCommand } from "./move.js";

export function createTaskCommand(): Command {
  const task = new Command("task").description("Manage tracker tasks");

  addJsonAndDaemonHostOptions(
    task
      .command("ls")
      .description("List tasks")
      .option("--status <status>", "Filter by stored status (backlog, todo, in_progress, …)")
      .option("--project <prefixOrId>", "Filter by tracker project prefix or id"),
  ).action(withOutput(runLsCommand));

  addJsonAndDaemonHostOptions(
    task
      .command("create")
      .description("Capture a task (lands in backlog)")
      .argument("<title>", "Task title")
      .option("--project <prefixOrId>", "Tracker project prefix or id (default: the first one)"),
  ).action(withOutput(runCreateCommand));

  addJsonAndDaemonHostOptions(
    task
      .command("move")
      .description("Move a task to a status column")
      .argument("<task>", "Task key (PSE-42) or id")
      .argument("<status>", "Target status"),
  ).action(withOutput(runMoveCommand));

  return task;
}
