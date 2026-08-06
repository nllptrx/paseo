import type { Locator } from "@playwright/test";
import { expect, test, type Page } from "../support/fixtures";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";
import { buildKanbansRoute } from "../../src/utils/host-routes";

interface KanbanSeedClient {
  kanbanCreate(input: { projectId: string }): Promise<{
    kanban: {
      id: string;
      name: string;
      columns: Array<{ id: string; name: string; role: string | null; planIds: string[] }>;
    } | null;
    error: string | null;
  }>;
  kanbanGet(kanbanId: string): Promise<{
    kanban: {
      id: string;
      columns: Array<{ id: string; name: string; planIds: string[] }>;
      plans: Record<
        string,
        { id: string; title: string; body: { type: string; steps?: Array<{ runs: unknown[] }> } }
      >;
    } | null;
    error: string | null;
  }>;
  kanbanPlanCreate(input: {
    kanbanId: string;
    columnId: string;
    title: string;
    body: {
      type: "workflow";
      steps: Array<{
        name: string;
        prompt: string;
        agents: Array<{ provider: string }>;
        completion: "all";
        workspace: { mode: "existing"; workspaceId: string };
        trigger: { type: "manual" };
      }>;
    };
  }): Promise<{ plan: { id: string; title: string } | null; error: string | null }>;
  kanbanArchive(input: { kanbanId: string }): Promise<{ error: string | null }>;
}

const DRAG_ACTIVATION_DISTANCE_PX = 6;

async function seedKanbanWithPlan(
  workspace: SeededWorkspace,
  title: string,
): Promise<{ kanbanId: string; planId: string; columns: Array<{ id: string; name: string }> }> {
  const client = workspace.client as unknown as KanbanSeedClient;
  const created = await client.kanbanCreate({ projectId: workspace.projectId });
  if (!created.kanban) {
    throw new Error(created.error ?? "Failed to create kanban");
  }
  const backlog =
    created.kanban.columns.find((column) => column.role === "backlog") ?? created.kanban.columns[0];
  if (!backlog) {
    throw new Error("Kanban has no columns");
  }
  const plan = await client.kanbanPlanCreate({
    kanbanId: created.kanban.id,
    columnId: backlog.id,
    title,
    body: {
      type: "workflow",
      steps: [
        {
          name: title,
          prompt: title,
          agents: [{ provider: "mock" }],
          completion: "all",
          workspace: { mode: "existing", workspaceId: workspace.workspaceId },
          trigger: { type: "manual" },
        },
      ],
    },
  });
  if (!plan.plan) {
    throw new Error(plan.error ?? "Failed to create plan");
  }
  return {
    kanbanId: created.kanban.id,
    planId: plan.plan.id,
    columns: created.kanban.columns.map((column) => ({ id: column.id, name: column.name })),
  };
}

async function archiveKanban(workspace: SeededWorkspace, kanbanId: string): Promise<void> {
  const result = await (workspace.client as unknown as KanbanSeedClient).kanbanArchive({
    kanbanId,
  });
  if (result.error) {
    throw new Error(`Failed to archive kanban ${kanbanId}: ${result.error}`);
  }
}

async function planHasStepRun(
  workspace: SeededWorkspace,
  kanbanId: string,
  planId: string,
): Promise<boolean> {
  const detail = await (workspace.client as unknown as KanbanSeedClient).kanbanGet(kanbanId);
  const plan = detail.kanban?.plans[planId];
  if (!plan || plan.body.type !== "workflow") {
    return false;
  }
  return (plan.body.steps ?? []).some((step) => step.runs.length > 0);
}

async function kanbanHasPlanTitled(
  workspace: SeededWorkspace,
  kanbanId: string,
  title: string,
): Promise<boolean> {
  const detail = await (workspace.client as unknown as KanbanSeedClient).kanbanGet(kanbanId);
  if (!detail.kanban) {
    return false;
  }
  return Object.values(detail.kanban.plans).some((plan) => plan.title === title);
}

/**
 * dnd-kit's MouseSensor needs a mousedown, then movement past its activation
 * distance, before it starts tracking collisions. Playwright's dragTo() emits a
 * single mousemove, which activates the sensor but leaves it without a resolved
 * droppable, so the drop is dismissed. Stepping the pointer manually gives the
 * sensor the intermediate moves it needs.
 */
async function dragCardOntoColumn(page: Page, card: Locator, column: Locator): Promise<void> {
  const from = await card.boundingBox();
  const to = await column.boundingBox();
  if (!from || !to) {
    throw new Error("Drag source or target is not laid out");
  }
  const startX = from.x + from.width / 2;
  const startY = from.y + from.height / 2;
  const endX = to.x + to.width / 2;
  const endY = to.y + Math.min(to.height / 2, from.height);

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + DRAG_ACTIVATION_DISTANCE_PX * 2, startY, { steps: 4 });
  await page.mouse.move(endX, endY, { steps: 12 });
  await page.mouse.move(endX, endY, { steps: 2 });
  await page.mouse.up();
}

async function openKanbans(page: Page): Promise<void> {
  await page.goto(buildKanbansRoute());
  await waitForSidebarHydration(page);
}

test.describe("Kanbans board", () => {
  const cleanupTasks: Array<() => Promise<void>> = [];

  test.afterEach(async () => {
    while (cleanupTasks.length > 0) {
      const task = cleanupTasks.pop();
      if (task) {
        await task();
      }
    }
  });

  test("shows empty state when the host has no kanbans", async ({ page }) => {
    const workspace = await seedWorkspace({ repoPrefix: "kanban-empty-" });
    cleanupTasks.push(() => workspace.cleanup());

    await openKanbans(page);
    await expect(page.getByText("No kanbans yet")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("sidebar-kanbans")).toBeVisible();
  });

  test("renders a seeded board and creates a plan", async ({ page }) => {
    const workspace = await seedWorkspace({ repoPrefix: "kanban-board-" });
    cleanupTasks.push(() => workspace.cleanup());
    const planTitle = `Seeded plan ${Date.now()}`;
    const seeded = await seedKanbanWithPlan(workspace, planTitle);
    cleanupTasks.push(() => archiveKanban(workspace, seeded.kanbanId));

    await openKanbans(page);
    await expect(page.getByTestId(`kanban-board-${seeded.kanbanId}`)).toBeVisible({
      timeout: 30_000,
    });
    const card = page.getByTestId(`kanban-card-${seeded.planId}`);
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card).toContainText(planTitle);

    // Several kanbans share the page, so every column locator is scoped to one board.
    const board = page.getByTestId(`kanban-board-${seeded.kanbanId}`);
    // A plan whose steps have never run reads as a draft, wherever it is stored.
    await expect(board.getByTestId("kanban-column-draft")).toContainText(planTitle);

    const createTitle = `UI plan ${Date.now()}`;
    await board.getByTestId("kanban-column-add-draft").click();
    const form = page.getByTestId("kanban-plan-form-sheet");
    await expect(form).toBeVisible({ timeout: 10_000 });
    await page.getByTestId("kanban-plan-form-title-input").fill(createTitle);
    await page.getByTestId("kanban-plan-form-prompt-input").fill(createTitle);
    const providerTrigger = page.getByTestId("kanban-plan-form-provider-trigger");
    await expect(providerTrigger).toBeVisible({ timeout: 30_000 });
    await expect.poll(async () => providerTrigger.isEnabled(), { timeout: 30_000 }).toBe(true);
    await page.getByTestId("kanban-plan-form-submit").click();
    await expect(form).toHaveCount(0, { timeout: 30_000 });

    await expect
      .poll(() => kanbanHasPlanTitled(workspace, seeded.kanbanId, createTitle), { timeout: 30_000 })
      .toBe(true);

    await expect(page.getByText(createTitle).first()).toBeVisible({ timeout: 30_000 });
  });

  test("dragging a draft onto the running column runs its first step", async ({ page }) => {
    const workspace = await seedWorkspace({ repoPrefix: "kanban-dnd-" });
    cleanupTasks.push(() => workspace.cleanup());
    const planTitle = `Drag plan ${Date.now()}`;
    const seeded = await seedKanbanWithPlan(workspace, planTitle);
    cleanupTasks.push(() => archiveKanban(workspace, seeded.kanbanId));

    await openKanbans(page);
    const board = page.getByTestId(`kanban-board-${seeded.kanbanId}`);
    const card = board.getByTestId(`kanban-card-${seeded.planId}`);
    await expect(card).toBeVisible({ timeout: 30_000 });
    const target = board.getByTestId("kanban-column-body-inProgress");
    await expect(target).toBeVisible();

    await dragCardOntoColumn(page, card, target);

    // The drop is a run request, so the proof is a step run on the daemon: the
    // card only leaves Draft because that run exists.
    await expect
      .poll(() => planHasStepRun(workspace, seeded.kanbanId, seeded.planId), { timeout: 30_000 })
      .toBe(true);
  });
});
