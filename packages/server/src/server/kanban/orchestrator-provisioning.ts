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
  // Rolls back a just-created workspace (and any agent inside it) if stamping the
  // orchestrator pointer fails after the workspace/agent already exist.
  archiveWorkspace: (workspaceId: string) => Promise<void>;
  logger: Logger;
}

/**
 * Provisions an Orchestrator for a kanban: a `local` workspace on the project root, a
 * primary agent in it stamped with the orchestrator labels, and the kanban's
 * orchestrator pointer — atomically from the caller's point of view. If stamping the
 * pointer fails (for example a concurrent provision already claimed it), the freshly
 * created workspace is rolled back so no orphaned orchestrator workspace is left behind.
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
  if (kanban.orchestrator) {
    throw new Error(`Kanban already has an orchestrator: ${kanbanId}`);
  }

  const project = await deps.projectRegistry.get(kanban.projectId);
  if (!project) {
    throw new Error(`Project not found: ${kanban.projectId}`);
  }

  const title = `${kanban.name} Orchestrator`;
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
    });
    agentId = created.snapshot.id;

    return await deps.kanbanService.provisionOrchestratorPointer(kanbanId, {
      workspaceId: workspace.workspaceId,
      agentId,
    });
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
