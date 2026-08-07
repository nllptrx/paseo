import { expect, test } from "../support/fixtures";
import { seedWorkspace } from "../support/helpers/seed-client";
import { buildTasksRoute } from "../../src/utils/host-routes";

interface TasksSeedClient {
  tasksSnapshot(): Promise<{
    snapshot: {
      tasks: Array<{ id: string; title: string; number: number; status: string }>;
      projects: Array<{ id: string; prefix: string }>;
    } | null;
    error: string | null;
  }>;
}

test.describe("Tasks", () => {
  /**
   * The whole stack in one pass: the screen creates a project and a task, the
   * daemon persists them in SQLite, and the list reads them back. Nothing here
   * is stubbed — a green run means the tracker works.
   */
  test("creates a first project and task, and lists it back", async ({ page }) => {
    const workspace = await seedWorkspace({ repoPrefix: "tasks-" });
    const client = workspace.client as unknown as TasksSeedClient;
    const listTitles = async (): Promise<string[]> => {
      const payload = await client.tasksSnapshot();
      return (payload.snapshot?.tasks ?? []).map((task) => task.title);
    };

    try {
      await page.goto(buildTasksRoute());

      await expect(page.getByTestId("tasks-new")).toBeVisible({ timeout: 30_000 });
      await page.getByTestId("tasks-new").click();

      const sheet = page.getByTestId("tasks-form-sheet");
      await expect(sheet).toBeVisible({ timeout: 10_000 });

      // A first-run host has no task project, so the sheet asks for one rather
      // than sending the reader somewhere else to make it.
      await page.getByTestId("tasks-form-project-name-input").fill("Paseo");
      await page.getByTestId("tasks-form-prefix-input").fill("pse");
      const title = `Ship the tracker ${Date.now()}`;
      await page.getByTestId("tasks-form-title-input").fill(title);
      await page.getByTestId("tasks-form-submit").click();
      await expect(sheet).toHaveCount(0, { timeout: 30_000 });

      // The daemon is the proof, not the screen: the row only renders because a
      // row exists in tasks.db.
      await expect.poll(listTitles, { timeout: 30_000 }).toContain(title);

      const snapshot = await client.tasksSnapshot();
      // Prefixes are stored upper case, and the first task of a project is 1.
      expect(snapshot.snapshot?.projects[0]?.prefix).toBe("PSE");
      expect(snapshot.snapshot?.tasks[0]?.number).toBe(1);
      expect(snapshot.snapshot?.tasks[0]?.status).toBe("backlog");

      await expect(page.getByText(title).first()).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId("tasks-group-backlog")).toBeVisible();
      await expect(page.getByText("PSE-1").first()).toBeVisible();

      // One object, two representations: the tab changes how the same task is
      // drawn, not which task is there.
      await page.getByTestId("tasks-view-picker").getByText("Board").click();
      const board = page.getByTestId("task-board");
      await expect(board).toBeVisible({ timeout: 10_000 });
      const taskId = (await client.tasksSnapshot()).snapshot?.tasks[0]?.id ?? "";
      await expect(board.getByTestId(`task-card-${taskId}`)).toContainText(title);
      // Canceled earns its column only when something is in it.
      await expect(page.getByTestId("task-column-backlog")).toBeVisible();
      await expect(page.getByTestId("task-column-canceled")).toHaveCount(0);

      // Moving it on the board writes through to the daemon.
      await page.getByTestId(`task-card-status-${taskId}`).click();
      await page.getByTestId(`task-card-status-${taskId}-in_progress`).click();
      await expect
        .poll(async () => (await client.tasksSnapshot()).snapshot?.tasks[0]?.status, {
          timeout: 30_000,
        })
        .toBe("in_progress");
    } finally {
      await workspace.cleanup();
    }
  });
});
