import type { Locator } from "@playwright/test";
import { expect, test, type Page } from "../support/fixtures";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";
import { buildKanbansRoute } from "../../src/utils/host-routes";

interface TrackerSeedClient {
  tasksProjectCreate(input: {
    name: string;
    prefix: string;
    color: string;
    paseoProjectId?: string | null;
  }): Promise<{ project: { id: string } | null; error: string | null }>;
  tasksCreate(input: {
    projectId: string;
    title: string;
    status?: string;
  }): Promise<{ task: { id: string; status: string } | null; error: string | null }>;
  tasksSnapshot(): Promise<{
    snapshot: {
      tasks: Array<{ id: string; title: string; status: string }>;
      projects: Array<{ id: string; board?: { reviewEnabled: boolean } }>;
    } | null;
    error: string | null;
  }>;
}

const DRAG_ACTIVATION_DISTANCE_PX = 6;

function trackerClient(workspace: SeededWorkspace): TrackerSeedClient {
  return workspace.client as unknown as TrackerSeedClient;
}

let seededProjectCount = 0;

async function seedTrackerTask(
  workspace: SeededWorkspace,
  title: string,
  status?: string,
): Promise<{ projectId: string; taskId: string }> {
  const client = trackerClient(workspace);
  seededProjectCount += 1;
  const project = await client.tasksProjectCreate({
    name: "Board tracker",
    prefix: `T${seededProjectCount}${Date.now().toString(36)}`.slice(0, 8).toUpperCase(),
    color: "#7C6BF5",
    paseoProjectId: workspace.projectId,
  });
  if (!project.project) {
    throw new Error(project.error ?? "Failed to create tracker project");
  }
  const task = await client.tasksCreate({
    projectId: project.project.id,
    title,
    ...(status ? { status } : {}),
  });
  if (!task.task) {
    throw new Error(task.error ?? "Failed to create task");
  }
  return { projectId: project.project.id, taskId: task.task.id };
}

async function readTaskStatus(workspace: SeededWorkspace, taskId: string): Promise<string | null> {
  const payload = await trackerClient(workspace).tasksSnapshot();
  return payload.snapshot?.tasks.find((task) => task.id === taskId)?.status ?? null;
}

async function readBoardReviewEnabled(
  workspace: SeededWorkspace,
  projectId: string,
): Promise<boolean> {
  const payload = await trackerClient(workspace).tasksSnapshot();
  const project = payload.snapshot?.projects.find((entry) => entry.id === projectId);
  return project?.board?.reviewEnabled ?? false;
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

/** The overview is the way in; the board itself lives one press deeper. A board
 * is a tracker project, so that project's id addresses both. */
async function openBoard(page: Page, projectId: string): Promise<void> {
  await openKanbans(page);
  const entry = page.getByTestId(`task-board-overview-open-${projectId}`);
  await expect(entry).toBeVisible({ timeout: 30_000 });
  await entry.click();
  await expect(page.getByTestId(`kanban-board-${projectId}`)).toBeVisible({ timeout: 30_000 });
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

  test("shows the project's tasks by status and captures a new one", async ({ page }) => {
    const workspace = await seedWorkspace({ repoPrefix: "kanban-tasks-" });
    cleanupTasks.push(() => workspace.cleanup());
    const seededTitle = `Seeded task ${Date.now()}`;
    const seeded = await seedTrackerTask(workspace, seededTitle);

    await openBoard(page, seeded.projectId);
    const board = page.getByTestId(`kanban-board-${seeded.projectId}`);
    const card = board.getByTestId(`task-card-${seeded.taskId}`);
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card).toContainText(seededTitle);
    await expect(board.getByTestId("task-column-backlog")).toContainText(seededTitle);

    // Capture straight into Todo from that column's own +.
    const capturedTitle = `Captured task ${Date.now()}`;
    await board.getByTestId("task-column-add-todo").click();
    const form = page.getByTestId("tasks-form-sheet");
    await expect(form).toBeVisible({ timeout: 10_000 });
    await page.getByTestId("tasks-form-title-input").fill(capturedTitle);
    await page.getByTestId("tasks-form-submit").click();
    await expect(form).toHaveCount(0, { timeout: 30_000 });

    await expect(board.getByTestId("task-column-todo")).toContainText(capturedTitle, {
      timeout: 30_000,
    });
    const snapshot = await trackerClient(workspace).tasksSnapshot();
    const captured = snapshot.snapshot?.tasks.find((task) => task.title === capturedTitle);
    expect(captured?.status).toBe("todo");
  });

  test("dragging a card onto another column writes the status through", async ({ page }) => {
    const workspace = await seedWorkspace({ repoPrefix: "kanban-task-dnd-" });
    cleanupTasks.push(() => workspace.cleanup());
    const title = `Drag task ${Date.now()}`;
    const seeded = await seedTrackerTask(workspace, title);

    await openBoard(page, seeded.projectId);
    const board = page.getByTestId(`kanban-board-${seeded.projectId}`);
    const card = board.getByTestId(`task-card-${seeded.taskId}`);
    await expect(card).toBeVisible({ timeout: 30_000 });
    const target = board.getByTestId("task-column-body-in_progress");
    await expect(target).toBeVisible();

    await dragCardOntoColumn(page, card, target);

    // The card follows the gesture rather than the round trip.
    await expect(target.getByTestId(`task-card-${seeded.taskId}`)).toBeVisible({
      timeout: 5_000,
    });
    // The proof is the stored status on the daemon, not the pixels.
    await expect
      .poll(() => readTaskStatus(workspace, seeded.taskId), { timeout: 30_000 })
      .toBe("in_progress");
  });

  test("the card menu moves a task without a drag", async ({ page }) => {
    const workspace = await seedWorkspace({ repoPrefix: "kanban-task-menu-" });
    cleanupTasks.push(() => workspace.cleanup());
    const title = `Menu task ${Date.now()}`;
    const seeded = await seedTrackerTask(workspace, title);

    await openBoard(page, seeded.projectId);
    const board = page.getByTestId(`kanban-board-${seeded.projectId}`);
    await expect(board.getByTestId(`task-card-${seeded.taskId}`)).toBeVisible({
      timeout: 30_000,
    });

    await page.getByTestId(`task-card-status-${seeded.taskId}`).click();
    await page.getByTestId(`task-card-status-${seeded.taskId}-done`).click();

    await expect
      .poll(() => readTaskStatus(workspace, seeded.taskId), { timeout: 30_000 })
      .toBe("done");
    await expect(board.getByTestId("task-column-done")).toContainText(title);
  });

  test("an In Review card offers a verdict: approve to done, reject back to work", async ({
    page,
  }) => {
    const workspace = await seedWorkspace({ repoPrefix: "kanban-verdict-" });
    cleanupTasks.push(() => workspace.cleanup());
    const approved = await seedTrackerTask(workspace, `Approve me ${Date.now()}`, "in_review");

    await openBoard(page, approved.projectId);
    const board = page.getByTestId(`kanban-board-${approved.projectId}`);
    await expect(board.getByTestId(`task-card-${approved.taskId}`)).toBeVisible({
      timeout: 30_000,
    });

    await page.getByTestId(`task-card-status-${approved.taskId}`).click();
    await page.getByTestId(`task-card-approve-${approved.taskId}`).click();
    await expect
      .poll(() => readTaskStatus(workspace, approved.taskId), { timeout: 30_000 })
      .toBe("done");

    const rejected = await trackerClient(workspace).tasksCreate({
      projectId: approved.projectId,
      title: `Reject me ${Date.now()}`,
      status: "in_review",
    });
    if (!rejected.task) {
      throw new Error(rejected.error ?? "Failed to seed the rejected task");
    }
    const rejectedTaskId = rejected.task.id;
    const rejectedCard = board.getByTestId(`task-card-${rejectedTaskId}`);
    await expect(rejectedCard).toBeVisible({ timeout: 30_000 });
    await page.getByTestId(`task-card-status-${rejectedTaskId}`).click();
    await page.getByTestId(`task-card-reject-${rejectedTaskId}`).click();
    // No review config on this board, so reject falls back to in_progress.
    await expect
      .poll(() => readTaskStatus(workspace, rejectedTaskId), { timeout: 30_000 })
      .toBe("in_progress");
  });

  test("the board menu toggles review, and a card authors a workflow", async ({ page }) => {
    const workspace = await seedWorkspace({ repoPrefix: "kanban-review-" });
    cleanupTasks.push(() => workspace.cleanup());

    // Review is board config, and the board is the tracker project — so the
    // toggle needs one to exist.
    const { projectId, taskId } = await seedTrackerTask(workspace, `Review seed ${Date.now()}`);
    await openBoard(page, projectId);

    await page.getByTestId(`kanban-board-menu-${projectId}`).click();
    await page.getByTestId(`kanban-review-toggle-${projectId}`).click();
    await expect
      .poll(async () => readBoardReviewEnabled(workspace, projectId), { timeout: 30_000 })
      .toBe(true);

    // A workflow belongs to a card, so it is authored from the card's menu.
    const board = page.getByTestId(`kanban-board-${projectId}`);
    await board.getByTestId(`task-card-status-${taskId}`).click();
    await page.getByTestId(`task-card-add-workflow-${taskId}`).click();
    await expect(page.getByTestId("task-workflow-form-sheet")).toBeVisible({ timeout: 10_000 });
  });
});

test.describe("Kanbans overview", () => {
  test("lists a project column and drills into its task board", async ({ page }) => {
    const workspace = await seedWorkspace({ repoPrefix: "kanban-overview-" });
    const title = `Overview task ${Date.now()}`;

    try {
      const { projectId } = await seedTrackerTask(workspace, title);
      await openKanbans(page);
      const column = page.getByTestId(`task-board-overview-${projectId}`);
      await expect(column).toBeVisible({ timeout: 30_000 });
      await expect(column).toContainText(title);

      await page.getByTestId(`task-board-overview-open-${projectId}`).click();
      await expect(page).toHaveURL(new RegExp(`/kanbans/${projectId}$`));
      const board = page.getByTestId(`kanban-board-${projectId}`);
      await expect(board.getByTestId("task-column-backlog")).toBeVisible({ timeout: 30_000 });
      await expect(board.getByTestId("task-column-in_progress")).toBeVisible();
      await expect(board.getByTestId("task-column-backlog")).toContainText(title);

      await page.getByTestId("sidebar-kanbans").click();
      await expect(page).toHaveURL(/\/kanbans$/);
      await expect(page.getByTestId(`task-board-overview-${projectId}`)).toBeVisible();
    } finally {
      await workspace.cleanup();
    }
  });
});
