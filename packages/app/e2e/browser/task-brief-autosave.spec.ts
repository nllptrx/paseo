import { expect, test, type Page } from "../support/fixtures";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";
import { buildKanbansRoute } from "../../src/utils/host-routes";

interface CaptureClient {
  tasksProjectCreate(input: {
    name: string;
    prefix: string;
    color: string;
    paseoProjectId?: string | null;
  }): Promise<{ project: { id: string } | null; error: string | null }>;
  tasksCreate(input: {
    projectId: string;
    title: string;
  }): Promise<{ task: { id: string } | null; error: string | null }>;
  tasksSnapshot(): Promise<{
    snapshot: { tasks: Array<{ id: string; description?: string }> } | null;
    error: string | null;
  }>;
}

function client(workspace: SeededWorkspace): CaptureClient {
  return workspace.client as unknown as CaptureClient;
}

async function readDescription(
  workspace: SeededWorkspace,
  taskId: string,
): Promise<string | undefined> {
  const payload = await client(workspace).tasksSnapshot();
  return payload.snapshot?.tasks.find((task) => task.id === taskId)?.description;
}

async function openBoard(page: Page, projectId: string): Promise<void> {
  await page.goto(buildKanbansRoute());
  await waitForSidebarHydration(page);
  const entry = page.getByTestId(`task-board-overview-open-${projectId}`);
  await expect(entry).toBeVisible({ timeout: 30_000 });
  await entry.click();
  await expect(page.getByTestId(`kanban-board-${projectId}`)).toBeVisible({ timeout: 30_000 });
}

test("the brief saves itself while typing and keeps what came after", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const workspace = await seedWorkspace({ repoPrefix: "autosave-" });
  const api = client(workspace);
  const project = await api.tasksProjectCreate({
    name: "Board tracker",
    prefix: "AUT",
    color: "#7C6BF5",
    paseoProjectId: workspace.projectId,
  });
  if (!project.project) throw new Error("no project");
  const task = await api.tasksCreate({
    projectId: project.project.id,
    title: "Make the flashcard app safe",
  });
  if (!task.task) throw new Error("no task");
  const taskId = task.task.id;

  await openBoard(page, project.project.id);
  await page.getByTestId(`task-card-${taskId}`).click();
  const sheet = page.getByTestId("task-detail-sheet");
  await expect(sheet).toBeVisible({ timeout: 15_000 });
  await sheet.getByTestId("task-detail-tab-details").click();
  const brief = sheet.getByTestId("task-detail-description-input");
  const hint = sheet.getByTestId("task-detail-brief-save-state");

  // Typing alone has to reach the host: no blur anywhere in this test.
  await brief.click();
  await brief.pressSequentially("Runs entirely on the developer machine", { delay: 20 });
  await expect(hint).toContainText("Saving");
  await expect
    .poll(() => readDescription(workspace, taskId), { timeout: 15_000 })
    .toBe("Runs entirely on the developer machine");
  await expect(hint).toContainText("Saved");

  // Keep typing straight after the write lands: the echo of the shorter text
  // must not reset the field under the cursor.
  await brief.pressSequentially(" and nowhere else", { delay: 20 });
  await expect
    .poll(() => readDescription(workspace, taskId), { timeout: 15_000 })
    .toBe("Runs entirely on the developer machine and nowhere else");
  await expect(brief).toHaveValue("Runs entirely on the developer machine and nowhere else");
  await workspace.cleanup();
});
