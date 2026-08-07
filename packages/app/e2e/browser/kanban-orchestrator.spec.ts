import { expect, test } from "../support/fixtures";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";
import { buildKanbansRoute } from "../../src/utils/host-routes";

interface OrchestratorSeedClient {
  kanbanCreate(input: { projectId: string }): Promise<{
    kanban: { id: string } | null;
    error: string | null;
  }>;
  kanbanArchive(input: { kanbanId: string }): Promise<{ error: string | null }>;
  kanbanOrchestratorListPeers(): Promise<{
    peers: Array<{ kanbanId: string; workspaceId: string; agentId: string }>;
    error: string | null;
  }>;
}

async function countOrchestrators(
  client: OrchestratorSeedClient,
  kanbanId: string,
): Promise<number> {
  const result = await client.kanbanOrchestratorListPeers();
  return result.peers.filter((peer) => peer.kanbanId === kanbanId).length;
}

test.describe("Kanban Orchestrator", () => {
  const cleanupTasks: Array<() => Promise<void>> = [];

  test.afterEach(async () => {
    while (cleanupTasks.length > 0) {
      const task = cleanupTasks.pop();
      if (task) {
        await task();
      }
    }
  });

  test("provisioning an orchestrator opens a board-and-peers pane", async ({ page }) => {
    const workspace: SeededWorkspace = await seedWorkspace({ repoPrefix: "kanban-orch-" });
    cleanupTasks.push(() => workspace.cleanup());
    const client = workspace.client as unknown as OrchestratorSeedClient;

    const created = await client.kanbanCreate({ projectId: workspace.projectId });
    if (!created.kanban) {
      throw new Error(created.error ?? "kanban create failed");
    }
    const kanbanId = created.kanban.id;
    cleanupTasks.push(async () => {
      await client.kanbanArchive({ kanbanId });
    });

    await page.goto(buildKanbansRoute());
    await waitForSidebarHydration(page);
    // The overview lists projects; the board — and its actions — live one press in.
    const entry = page.getByTestId(`kanban-overview-open-${kanbanId}`);
    await expect(entry).toBeVisible({ timeout: 30_000 });
    await entry.click();
    await expect(page.getByTestId(`kanban-board-${kanbanId}`)).toBeVisible({ timeout: 30_000 });

    await page.getByTestId(`kanban-board-menu-${kanbanId}`).click();
    await page.getByTestId(`kanban-create-orchestrator-${kanbanId}`).click();

    // An Orchestrator is an agent wearing the kanban's labels, so it shows up as a
    // peer once the agent exists — nothing is stamped on the board.
    await expect.poll(() => countOrchestrators(client, kanbanId), { timeout: 60_000 }).toBe(1);

    // The board's own Orchestrator is reachable without leaving the board: the
    // pane beside it opens straight into the conversation when there is only one.
    const pane = page.getByTestId("kanban-orchestrator-pane");
    await expect(pane).toBeVisible({ timeout: 30_000 });
    await expect(pane.getByTestId("orchestrator-thread-input")).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("kanban-orchestrator-pane-toggle").click();
    await expect(pane).toHaveCount(0);
    await page.getByTestId("kanban-orchestrator-pane-toggle").click();
    await expect(pane).toBeVisible();

    // Reached the way a user would: the provisioned workspace shows up in the
    // sidebar, and its header menu is where the pane opens from.
    await page.getByText("Kanban Orchestrator").first().click();
    await page.waitForURL((url) => url.pathname.includes("/workspace/"), { timeout: 30_000 });
    await page.getByTestId("workspace-header-menu-trigger").click();
    const openOrchestrator = page.getByTestId("workspace-header-open-orchestrator");
    await expect(openOrchestrator).toBeVisible({ timeout: 30_000 });
    await openOrchestrator.click();

    const panel = page.getByTestId("orchestrator-panel");
    await expect(panel).toBeVisible({ timeout: 30_000 });
    // Board on the left, peers on the right: the pane is the steering surface,
    // not just a link back to the board.
    await expect(panel.getByTestId("kanban-column-draft")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("orchestrator-rail-scroll")).toBeVisible();
  });
});
