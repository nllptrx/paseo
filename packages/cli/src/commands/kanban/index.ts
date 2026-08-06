import { Command } from "commander";
import { withOutput } from "../../output/index.js";
import { addJsonAndDaemonHostOptions } from "../../utils/command-options.js";
import { runLsCommand } from "./ls.js";
import { runInspectCommand } from "./inspect.js";
import { runCreateCommand } from "./create.js";
import { runArchiveCommand } from "./archive.js";
import { runPeersCommand } from "./peers.js";

export function createKanbanCommand(): Command {
  const kanban = new Command("kanban").description("Manage kanbans");

  addJsonAndDaemonHostOptions(kanban.command("ls").description("List kanbans")).action(
    withOutput(runLsCommand),
  );

  addJsonAndDaemonHostOptions(
    kanban.command("inspect").description("Inspect a kanban").argument("<id>", "Kanban ID"),
  ).action(withOutput(runInspectCommand));

  addJsonAndDaemonHostOptions(
    kanban
      .command("create")
      .description("Create a kanban for a project")
      .option("--project <projectId>", "Project ID (default: resolve from --cwd)")
      .option("--name <name>", "Kanban name")
      .option("--cwd <path>", "Working directory used to resolve the project (default: current)"),
  ).action(withOutput(runCreateCommand));

  addJsonAndDaemonHostOptions(
    kanban.command("archive").description("Archive a kanban").argument("<id>", "Kanban ID"),
  ).action(withOutput(runArchiveCommand));

  addJsonAndDaemonHostOptions(
    kanban.command("peers").description("List orchestrator peers on this host"),
  ).action(withOutput(runPeersCommand));

  return kanban;
}
