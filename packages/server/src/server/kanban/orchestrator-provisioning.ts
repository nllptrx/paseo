import type { Logger } from "pino";
import type { StoredKanban } from "@getpaseo/protocol/kanban/types";
import type {
  CreateAgentFromMcpInput,
  CreateAgentCommandResult,
} from "../agent/create-agent/create.js";
import type { PersistedWorkspaceRecord, ProjectRegistry } from "../workspace-registry.js";
import { KANBAN_ID_LABEL, KANBAN_ORCHESTRATOR_LABEL } from "./labels.js";
import type { KanbanService } from "./service.js";

export interface OrchestratorProvisioningDeps {
  kanbanService: KanbanService;
  projectRegistry: Pick<ProjectRegistry, "get">;
  createDirectoryWorkspace: (
    cwd: string,
    title?: string | null,
    projectId?: string,
  ) => Promise<PersistedWorkspaceRecord>;
  createAgent: (input: CreateAgentFromMcpInput) => Promise<CreateAgentCommandResult>;
  resolveDefaultProvider: () => Promise<string>;
  // Rolls back a just-created workspace (and any agent inside it) when the agent
  // fails to come up after the workspace already exists.
  archiveWorkspace: (workspaceId: string) => Promise<void>;
  logger: Logger;
}

/**
 * What the Orchestrator is told on its first turn. Without it the agent is just a
 * model sitting in a directory: asked about the board it greps the repository,
 * because nothing ever told it the board exists or that it has tools for it.
 */
function buildOrchestratorBriefing(kanban: StoredKanban): string {
  const planCount = Object.values(kanban.plans).filter((plan) => !plan.archivedAt).length;
  return [
    `You are the Orchestrator for the kanban "${kanban.name}" (id: ${kanban.id}).`,
    "",
    `That board currently holds ${planCount} plan(s). Read and steer it with the kanban`,
    "tools: get_kanban, list_plans, get_plan, create_plan, run_plan, archive_plan.",
    "Never answer questions about the board by searching the repository — the tools are",
    "the source of truth, and the working directory is only there so you can look at the",
    "code a plan refers to.",
    "",
    "Columns are derived from what the steps have run: a plan with no runs is a draft,",
    "one whose every step finished is done, anything in between is in progress. There is",
    "no way to move a card; running a step is what moves it.",
    "",
    "You steer, you do not implement. Dispatch work by running a plan's steps; talk to",
    "other Orchestrators through the orchestrators chat room.",
    "",
    "Reply with a short summary of the board as it stands.",
  ].join("\n");
}

/**
 * Provisions an Orchestrator for a kanban: a `local` workspace on the project root
 * and an agent in it wearing the kanban's labels. Those labels are what makes it an
 * Orchestrator — nothing is stamped on the board, so a kanban can have as many as
 * you start. If the agent fails to come up, the workspace is rolled back so no
 * orphaned orchestrator workspace is left behind.
 */
export async function provisionKanbanOrchestrator(
  deps: OrchestratorProvisioningDeps,
  kanbanId: string,
): Promise<StoredKanban> {
  const kanban = await deps.kanbanService.get(kanbanId);
  if (!kanban) {
    throw new Error(`Kanban not found: ${kanbanId}`);
  }
  if (kanban.archivedAt) {
    throw new Error(`Kanban is archived: ${kanbanId}`);
  }
  const project = await deps.projectRegistry.get(kanban.projectId);
  if (!project) {
    throw new Error(`Project not found: ${kanban.projectId}`);
  }

  const existing = await deps.kanbanService.listOrchestrators(kanbanId);
  const title =
    existing.length === 0
      ? `${kanban.name} Orchestrator`
      : `${kanban.name} Orchestrator ${existing.length + 1}`;
  const workspace = await deps.createDirectoryWorkspace(project.rootPath, title, kanban.projectId);

  let agentId: string | undefined;
  try {
    const provider = await deps.resolveDefaultProvider();
    const created = await deps.createAgent({
      kind: "mcp",
      provider,
      title,
      cwd: workspace.cwd,
      workspaceId: workspace.workspaceId,
      background: true,
      notifyOnFinish: false,
      labels: { [KANBAN_ORCHESTRATOR_LABEL]: "true", [KANBAN_ID_LABEL]: kanbanId },
      initialPrompt: buildOrchestratorBriefing(kanban),
    });
    agentId = created.snapshot.id;
    return kanban;
  } catch (error) {
    deps.logger.error(
      { err: error, kanbanId, workspaceId: workspace.workspaceId, agentId },
      "Failed to provision kanban orchestrator; rolling back workspace",
    );
    try {
      await deps.archiveWorkspace(workspace.workspaceId);
    } catch (rollbackError) {
      deps.logger.error(
        { err: rollbackError, workspaceId: workspace.workspaceId },
        "Failed to roll back orchestrator workspace after provisioning failure",
      );
    }
    throw error;
  }
}
