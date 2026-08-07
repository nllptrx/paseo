import type { Locator } from "@playwright/test";
import { expect, test, type Page } from "../support/fixtures";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";
import { buildKanbansRoute } from "../../src/utils/host-routes";

interface KanbanSeedClient {
  kanbanCreate(input: { projectId: string }): Promise<{
    kanban: { id: string; name: string } | null;
    error: string | null;
  }>;
  kanbanGet(kanbanId: string): Promise<{
    kanban: {
      id: string;
      plans: Record<
        string,
        {
          id: string;
          title: string;
          body: { type: string; steps?: Array<{ id: string; runs: unknown[] }> };
        }
      >;
    } | null;
    error: string | null;
  }>;
  kanbanPlanCreate(input: {
    kanbanId: string;
    title: string;
    description?: string;
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
  description?: string,
): Promise<{ kanbanId: string; planId: string }> {
  const client = workspace.client as unknown as KanbanSeedClient;
  const created = await client.kanbanCreate({ projectId: workspace.projectId });
  if (!created.kanban) {
    throw new Error(created.error ?? "Failed to create kanban");
  }
  const plan = await client.kanbanPlanCreate({
    kanbanId: created.kanban.id,
    title,
    ...(description ? { description } : {}),
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
  return { kanbanId: created.kanban.id, planId: plan.plan.id };
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

async function readFirstStepId(
  workspace: SeededWorkspace,
  kanbanId: string,
  planId: string,
): Promise<string> {
  const detail = await (workspace.client as unknown as KanbanSeedClient).kanbanGet(kanbanId);
  const stepId = detail.kanban?.plans[planId]?.body.steps?.[0]?.id;
  if (!stepId) {
    throw new Error(`Plan ${planId} has no steps`);
  }
  return stepId;
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

/** The overview is the way in; the board itself lives one press deeper. */
async function openBoard(page: Page, kanbanId: string): Promise<void> {
  await openKanbans(page);
  const entry = page.getByTestId(`kanban-overview-open-${kanbanId}`);
  await expect(entry).toBeVisible({ timeout: 30_000 });
  await entry.click();
  await expect(page.getByTestId(`kanban-board-${kanbanId}`)).toBeVisible({ timeout: 30_000 });
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
    // The board lives at its URL, not in the nav: there is one destination for
    // work now, and it is the tracker.
    await expect(page.getByTestId("sidebar-kanbans")).toHaveCount(0);
  });

  test("renders a seeded board and creates a plan", async ({ page }) => {
    const workspace = await seedWorkspace({ repoPrefix: "kanban-board-" });
    cleanupTasks.push(() => workspace.cleanup());
    const planTitle = `Seeded plan ${Date.now()}`;
    const seeded = await seedKanbanWithPlan(workspace, planTitle);
    cleanupTasks.push(() => archiveKanban(workspace, seeded.kanbanId));

    await openBoard(page, seeded.kanbanId);
    const card = page.getByTestId(`kanban-card-${seeded.planId}`);
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card).toContainText(planTitle);

    const board = page.getByTestId(`kanban-board-${seeded.kanbanId}`);
    // A plan whose steps have never run reads as a draft, wherever it is stored.
    await expect(board.getByTestId("kanban-column-draft")).toContainText(planTitle);

    const createTitle = `UI plan ${Date.now()}`;
    await board.getByTestId("kanban-column-add-draft").click();
    const form = page.getByTestId("kanban-plan-form-sheet");
    await expect(form).toBeVisible({ timeout: 10_000 });
    await page.getByTestId("kanban-plan-form-title-input").fill(createTitle);
    await page.getByTestId("kanban-plan-form-step-name-input-0").fill("Build");
    await page.getByTestId("kanban-plan-form-step-prompt-input-0").fill(createTitle);
    const providerTrigger = page.getByTestId("kanban-plan-form-provider-trigger-0");
    await expect(providerTrigger).toBeVisible({ timeout: 30_000 });
    await expect.poll(async () => providerTrigger.isEnabled(), { timeout: 30_000 }).toBe(true);
    await page.getByTestId("kanban-plan-form-submit").click();
    await expect(form).toHaveCount(0, { timeout: 30_000 });

    await expect
      .poll(() => kanbanHasPlanTitled(workspace, seeded.kanbanId, createTitle), { timeout: 30_000 })
      .toBe(true);

    await expect(page.getByText(createTitle).first()).toBeVisible({ timeout: 30_000 });
  });

  test("opening a draft card shows what the plan would run", async ({ page }) => {
    const workspace = await seedWorkspace({ repoPrefix: "kanban-plan-" });
    cleanupTasks.push(() => workspace.cleanup());
    const planTitle = `Sheet plan ${Date.now()}`;
    const description = "What this plan is for";
    const seeded = await seedKanbanWithPlan(workspace, planTitle, description);
    cleanupTasks.push(() => archiveKanban(workspace, seeded.kanbanId));
    const stepId = await readFirstStepId(workspace, seeded.kanbanId, seeded.planId);

    await openBoard(page, seeded.kanbanId);
    await page.getByTestId(`kanban-card-${seeded.planId}`).click();

    const sheet = page.getByTestId("kanban-plan-sheet");
    await expect(sheet).toBeVisible({ timeout: 30_000 });
    // The context you open a plan for: why it exists, what the step sends, where
    // it would run, and what has happened so far.
    await expect(sheet).toContainText(description);
    await expect(sheet).toContainText("An existing workspace");
    await expect(sheet).toContainText("Manually");
    await expect(sheet).toContainText("Not run yet");

    // A step that has never started can be run or skipped, and nothing else.
    await expect(page.getByTestId(`kanban-step-run-${stepId}`)).toBeVisible();
    await expect(page.getByTestId(`kanban-step-skip-${stepId}`)).toBeVisible();
    await expect(page.getByTestId(`kanban-step-retry-${stepId}`)).toHaveCount(0);
    await expect(page.getByTestId(`kanban-step-cancel-${stepId}`)).toHaveCount(0);
    await expect(page.getByTestId(`kanban-step-chat-${stepId}`)).toHaveCount(0);
  });

  test("right click and the new-plan shortcut reach the same actions as the buttons", async ({
    page,
  }) => {
    const workspace = await seedWorkspace({ repoPrefix: "kanban-shortcuts-" });
    cleanupTasks.push(() => workspace.cleanup());
    const planTitle = `Menu plan ${Date.now()}`;
    const seeded = await seedKanbanWithPlan(workspace, planTitle);
    cleanupTasks.push(() => archiveKanban(workspace, seeded.kanbanId));

    await openBoard(page, seeded.kanbanId);
    const card = page.getByTestId(`kanban-card-${seeded.planId}`);
    await expect(card).toBeVisible({ timeout: 30_000 });

    // Right click offers what the kebab offers, so a card is reachable the way
    // any other list row on this platform is.
    await card.click({ button: "right" });
    const contextMenu = page.getByTestId(`kanban-card-context-menu-${seeded.planId}`);
    await expect(contextMenu).toBeVisible({ timeout: 10_000 });
    await expect(
      contextMenu.getByTestId(`kanban-card-context-action-${seeded.planId}-run`),
    ).toBeVisible();
    await expect(
      contextMenu.getByTestId(`kanban-card-context-action-${seeded.planId}-archive`),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(contextMenu).toHaveCount(0);

    const modifier = process.platform === "darwin" ? "Meta" : "Control";
    await page.keyboard.press(`${modifier}+Alt+p`);
    await expect(page.getByTestId("kanban-plan-form-sheet")).toBeVisible({ timeout: 10_000 });
  });

  test("dragging a draft onto the running column runs its first step", async ({ page }) => {
    const workspace = await seedWorkspace({ repoPrefix: "kanban-dnd-" });
    cleanupTasks.push(() => workspace.cleanup());
    const planTitle = `Drag plan ${Date.now()}`;
    const seeded = await seedKanbanWithPlan(workspace, planTitle);
    cleanupTasks.push(() => archiveKanban(workspace, seeded.kanbanId));

    await openBoard(page, seeded.kanbanId);
    const board = page.getByTestId(`kanban-board-${seeded.kanbanId}`);
    const card = board.getByTestId(`kanban-card-${seeded.planId}`);
    await expect(card).toBeVisible({ timeout: 30_000 });
    const target = board.getByTestId("kanban-column-body-inProgress");
    await expect(target).toBeVisible();

    await dragCardOntoColumn(page, card, target);

    // The card follows the gesture rather than the round trip, so it is in the
    // running column before the daemon has been asked anything.
    await expect(target.getByTestId(`kanban-card-${seeded.planId}`)).toBeVisible({
      timeout: 5_000,
    });

    // The drop is a run request, so the proof is a step run on the daemon: the
    // card only stays out of Draft because that run exists.
    await expect
      .poll(() => planHasStepRun(workspace, seeded.kanbanId, seeded.planId), { timeout: 30_000 })
      .toBe(true);
    await expect(target.getByTestId(`kanban-card-${seeded.planId}`)).toBeVisible();
  });
});

test.describe("Kanbans overview", () => {
  test("lists a project column and drills into its board", async ({ page }) => {
    const workspace = await seedWorkspace({ repoPrefix: "kanban-overview-" });
    const planTitle = `Overview plan ${Date.now()}`;
    const seeded = await seedKanbanWithPlan(workspace, planTitle);

    try {
      await openKanbans(page);
      const column = page.getByTestId(`kanban-overview-${seeded.kanbanId}`);
      await expect(column).toBeVisible({ timeout: 30_000 });
      await expect(column).toContainText(planTitle);
      // One column per project on the overview, not the three-column board.
      await expect(column.getByTestId("kanban-column-draft")).toHaveCount(0);

      await page.getByTestId(`kanban-overview-open-${seeded.kanbanId}`).click();
      await expect(page).toHaveURL(new RegExp(`/kanbans/${seeded.kanbanId}$`));
      const board = page.getByTestId(`kanban-board-${seeded.kanbanId}`);
      await expect(board.getByTestId("kanban-column-draft")).toBeVisible({ timeout: 30_000 });
      await expect(board.getByTestId("kanban-column-inProgress")).toBeVisible();

      await page.getByTestId("kanban-board-back").click();
      await expect(page).toHaveURL(/\/kanbans$/);
      await expect(page.getByTestId(`kanban-overview-${seeded.kanbanId}`)).toBeVisible();
    } finally {
      await archiveKanban(workspace, seeded.kanbanId);
      await workspace.cleanup();
    }
  });
});
