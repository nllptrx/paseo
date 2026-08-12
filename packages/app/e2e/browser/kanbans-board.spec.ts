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
    parentTaskId?: string;
  }): Promise<{ task: { id: string; status: string } | null; error: string | null }>;
  tasksAgentAttach(input: {
    taskId: string;
    agentId: string;
    workspaceId: string;
  }): Promise<{ error: string | null }>;
  tasksWorkflowSet(input: {
    taskId: string;
    steps: Array<{
      name: string;
      prompt: string;
      agents: Array<{ provider: "claude" }>;
      completion: "all";
      workspace: { mode: "existing"; workspaceId: string };
      trigger: { type: "manual" };
    }>;
  }): Promise<{ error: string | null }>;
  tasksSnapshot(): Promise<{
    snapshot: {
      tasks: Array<{
        id: string;
        title: string;
        description?: string;
        status: string;
        priority: string;
        dueDate: string | null;
        parentTaskId?: string | null;
        executionPolicy?: {
          review?: string;
          workspace?: string;
        };
      }>;
      dependencies: Array<{ taskId: string; dependsOnTaskId: string }>;
      projects: Array<{
        id: string;
        board?: { reviewEnabled: boolean; maxReviewIterations?: number };
      }>;
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

async function seedSubtask(
  workspace: SeededWorkspace,
  input: { projectId: string; parentTaskId: string; title: string; status?: string },
): Promise<{ taskId: string }> {
  const task = await trackerClient(workspace).tasksCreate(input);
  if (!task.task) {
    throw new Error(task.error ?? "Failed to create subtask");
  }
  return { taskId: task.task.id };
}

async function readTaskStatus(workspace: SeededWorkspace, taskId: string): Promise<string | null> {
  const payload = await trackerClient(workspace).tasksSnapshot();
  return payload.snapshot?.tasks.find((task) => task.id === taskId)?.status ?? null;
}

async function readTaskPriority(
  workspace: SeededWorkspace,
  taskId: string,
): Promise<string | null> {
  const payload = await trackerClient(workspace).tasksSnapshot();
  return payload.snapshot?.tasks.find((task) => task.id === taskId)?.priority ?? null;
}

async function readTaskDueDate(workspace: SeededWorkspace, taskId: string): Promise<string | null> {
  const payload = await trackerClient(workspace).tasksSnapshot();
  return payload.snapshot?.tasks.find((task) => task.id === taskId)?.dueDate ?? null;
}

async function readTaskBriefAndPolicy(workspace: SeededWorkspace, taskId: string) {
  const snapshot = (await trackerClient(workspace).tasksSnapshot()).snapshot;
  for (const task of snapshot?.tasks ?? []) {
    if (task.id === taskId) {
      return {
        title: task.title,
        description: task.description,
        policy: task.executionPolicy,
      };
    }
  }
  return null;
}

async function hasSubtask(
  workspace: SeededWorkspace,
  input: { parentTaskId: string; title: string },
): Promise<boolean> {
  const snapshot = (await trackerClient(workspace).tasksSnapshot()).snapshot;
  for (const task of snapshot?.tasks ?? []) {
    if (task.title === input.title && task.parentTaskId === input.parentTaskId) return true;
  }
  return false;
}

async function hasDependencyBetweenTitles(
  workspace: SeededWorkspace,
  input: { blockedTitle: string; blockerTitle: string },
): Promise<boolean> {
  const snapshot = (await trackerClient(workspace).tasksSnapshot()).snapshot;
  let blockedId: string | undefined;
  let blockerId: string | undefined;
  for (const task of snapshot?.tasks ?? []) {
    if (task.title === input.blockedTitle) blockedId = task.id;
    if (task.title === input.blockerTitle) blockerId = task.id;
  }
  for (const edge of snapshot?.dependencies ?? []) {
    if (edge.taskId === blockedId && edge.dependsOnTaskId === blockerId) return true;
  }
  return false;
}

async function readBoardReviewEnabled(
  workspace: SeededWorkspace,
  projectId: string,
): Promise<boolean> {
  const payload = await trackerClient(workspace).tasksSnapshot();
  const project = payload.snapshot?.projects.find((entry) => entry.id === projectId);
  return project?.board?.reviewEnabled ?? false;
}

async function readBoardReviewIterations(
  workspace: SeededWorkspace,
  projectId: string,
): Promise<number | null> {
  const payload = await trackerClient(workspace).tasksSnapshot();
  return (
    payload.snapshot?.projects.find((entry) => entry.id === projectId)?.board
      ?.maxReviewIterations ?? null
  );
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

  test("shows every Paseo project before it has a board and creates the board on open", async ({
    page,
  }) => {
    const workspace = await seedWorkspace({ repoPrefix: "kanban-empty-" });
    cleanupTasks.push(() => workspace.cleanup());
    const unlinked = await trackerClient(workspace).tasksProjectCreate({
      name: "Unlinked development tracker",
      prefix: `U${Date.now().toString(36)}`.slice(0, 8).toUpperCase(),
      color: "#7C6BF5",
    });
    if (!unlinked.project) {
      throw new Error(unlinked.error ?? "Failed to create unlinked tracker project");
    }

    await openKanbans(page);
    await expect(page.getByTestId(`task-board-overview-open-${unlinked.project.id}`)).toHaveCount(
      0,
    );
    const project = page.getByTestId(`task-board-overview-open-${workspace.projectId}`);
    await expect(project).toBeVisible({ timeout: 30_000 });
    await project.click();
    await expect(page.getByTestId("task-surface-toolbar")).toBeVisible({ timeout: 30_000 });
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
    await expect(card.locator("button")).toHaveCount(0);
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

    await board.getByTestId("task-view-list").click();
    const taskList = board.getByTestId("task-list");
    await expect(taskList).toBeVisible();
    await expect(taskList.getByTestId("task-list-group-backlog")).toBeVisible();
    await expect(taskList.getByText(seededTitle)).toBeVisible();
    await expect(taskList.getByTestId("task-list-group-todo")).toBeVisible();
    await expect(taskList.getByText(capturedTitle)).toBeVisible();
    await expect(taskList.getByTestId(`task-list-key-${seeded.taskId}`)).toHaveCSS(
      "white-space",
      "nowrap",
    );
    await board.getByTestId("task-search").fill(seededTitle);
    await expect(taskList.getByText(capturedTitle)).toHaveCount(0);
    await board.getByTestId("task-filters-clear").click();
    await expect(taskList.getByText(capturedTitle)).toBeVisible();
    await taskList.getByTestId(`task-list-row-${seeded.taskId}`).click();
    await expect(page.getByTestId("task-detail-sheet")).toBeVisible();

    await page.getByTestId("task-detail-sheet").getByRole("button", { name: "Close" }).click();
    await board.getByTestId("task-view-kanban").click();
    await board.getByTestId("task-search").fill(seededTitle);
    await expect(card).toBeEnabled();
    await card.click();
    await expect(page.getByTestId("task-detail-sheet")).toBeVisible();

    await page.getByTestId("task-detail-sheet").getByRole("button", { name: "Close" }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await board.getByTestId("task-filters-clear").click();
    const columnPicker = board.getByTestId("task-board-column-picker");
    await expect(columnPicker).toBeVisible();
    const pickerBox = await columnPicker.boundingBox();
    const backlogBox = await board.getByTestId("task-column-backlog").boundingBox();
    expect(pickerBox).not.toBeNull();
    expect(backlogBox).not.toBeNull();
    expect(pickerBox!.y + pickerBox!.height).toBeLessThanOrEqual(backlogBox!.y);
    await columnPicker.getByRole("button", { name: "Todo" }).click();
    await expect(board.getByTestId("task-column-todo")).toContainText(capturedTitle);
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

  test("the task list edits status and priority directly and remembers its view", async ({
    page,
  }) => {
    const workspace = await seedWorkspace({ repoPrefix: "kanban-task-list-edit-" });
    cleanupTasks.push(() => workspace.cleanup());
    const seeded = await seedTrackerTask(workspace, `List edit ${Date.now()}`);

    await openBoard(page, seeded.projectId);
    const board = page.getByTestId(`kanban-board-${seeded.projectId}`);
    await board.getByTestId("task-view-list").click();
    const row = board.getByTestId(`task-list-row-${seeded.taskId}`);
    await expect(row).toBeVisible({ timeout: 30_000 });

    await row.getByTestId(`task-list-status-${seeded.taskId}`).click();
    await page.getByTestId(`task-list-status-${seeded.taskId}-todo`).click();
    await expect
      .poll(() => readTaskStatus(workspace, seeded.taskId), { timeout: 30_000 })
      .toBe("todo");

    await row.getByTestId(`task-list-priority-${seeded.taskId}`).click();
    await page.getByTestId(`task-list-priority-${seeded.taskId}-high`).click();
    await expect
      .poll(() => readTaskPriority(workspace, seeded.taskId), { timeout: 30_000 })
      .toBe("high");

    await page.reload();
    await waitForSidebarHydration(page);
    const reloadedBoard = page.getByTestId(`kanban-board-${seeded.projectId}`);
    await expect(reloadedBoard.getByTestId("task-list")).toBeVisible({ timeout: 30_000 });
    await expect(reloadedBoard.getByTestId(`task-list-row-${seeded.taskId}`)).toContainText("High");
  });

  test("an In Review card approves to done and explains a correction that cannot start", async ({
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
    // This manually seeded card has no worker to resume. It must stay in review
    // instead of pretending a correction round started.
    await expect
      .poll(() => readTaskStatus(workspace, rejectedTaskId), { timeout: 30_000 })
      .toBe("in_review");
    await expect(
      page.getByText("The task remains in Review; no correction round was started."),
    ).toBeVisible();
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

    await page.getByTestId(`kanban-board-menu-${projectId}`).click();
    await page.getByTestId(`kanban-review-policy-${projectId}`).click();
    await page.getByTestId(`kanban-review-iterations-${projectId}`).click();
    await page.getByTestId(`kanban-review-iterations-${projectId}-5`).click();
    await expect
      .poll(async () => readBoardReviewIterations(workspace, projectId), { timeout: 30_000 })
      .toBe(5);

    // A workflow belongs to a card, so it is authored from the card's menu.
    const board = page.getByTestId(`kanban-board-${projectId}`);
    await board.getByTestId(`task-card-status-${taskId}`).click();
    await page.getByTestId(`task-card-add-workflow-${taskId}`).click();
    await expect(page.getByTestId("task-workflow-form-sheet")).toBeVisible({ timeout: 10_000 });
  });

  test("editing a saved plan opens its actions", async ({ page }) => {
    const workspace = await seedWorkspace({ repoPrefix: "kanban-edit-plan-" });
    cleanupTasks.push(() => workspace.cleanup());
    const { projectId, taskId } = await seedTrackerTask(workspace, `Plan task ${Date.now()}`);
    const workflow = await trackerClient(workspace).tasksWorkflowSet({
      taskId,
      steps: [
        {
          name: "Inspect the project",
          prompt: "Read the relevant files before making changes.",
          agents: [{ provider: "claude" }],
          completion: "all",
          workspace: { mode: "existing", workspaceId: workspace.workspaceId },
          trigger: { type: "manual" },
        },
      ],
    });
    if (workflow.error) throw new Error(workflow.error);

    await openBoard(page, projectId);
    await page.getByTestId(`task-card-${taskId}`).click();
    const detail = page.getByTestId("task-detail-sheet");
    await expect(detail).toBeVisible({ timeout: 10_000 });
    await expect(detail.getByTestId("task-detail-workflow-edit")).toHaveText("Add step");
    await expect(detail.getByTestId("task-detail-workflow")).toContainText("Inspect the project");
    await detail.getByTestId("task-detail-workflow-edit").click();

    // Editing a saved plan stacks inside the task rather than opening a sheet of
    // its own, so leaving it returns to the task. The standalone form sheet is
    // still the board's own entry point, covered above.
    const form = detail.getByTestId("task-detail-plan-surface");
    await expect(form).toBeVisible({ timeout: 10_000 });
    // A saved step opens already showing its name and brief: the card is short
    // enough that collapsing it hid more than it saved.
    await expect(form.getByTestId("task-workflow-form-step-name-input-0")).toHaveValue(
      "Inspect the project",
    );
    await expect(form.getByTestId("task-workflow-form-step-prompt-input-0")).toHaveValue(
      "Read the relevant files before making changes.",
    );
    const promptInput = form.getByTestId("task-workflow-form-step-prompt-input-0");
    await expect(promptInput).toHaveCSS("resize", "none");
    await expect(promptInput).toHaveCSS("overflow-y", "auto");
    const promptResizeHandle = form.getByTestId(
      "task-workflow-form-step-prompt-input-0-resize-handle",
    );
    await expect(promptResizeHandle).toHaveCount(1);
    const beforeResize = await promptInput.boundingBox();
    const resizeHandleBox = await promptResizeHandle.boundingBox();
    if (!beforeResize) throw new Error("Agent brief is not laid out");
    if (!resizeHandleBox) throw new Error("Agent brief resize handle is not laid out");
    await page.mouse.move(
      resizeHandleBox.x + resizeHandleBox.width / 2,
      resizeHandleBox.y + resizeHandleBox.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      resizeHandleBox.x + resizeHandleBox.width / 2,
      resizeHandleBox.y + resizeHandleBox.height / 2 + 80,
    );
    await page.mouse.up();
    await expect
      .poll(async () => (await promptInput.boundingBox())?.height ?? 0)
      .toBeGreaterThan(beforeResize.height + 40);

    await form.getByTestId("task-detail-plan-add-step").click();
    const secondPromptInput = form.getByTestId("task-workflow-form-step-prompt-input-1");
    await expect(secondPromptInput).toHaveCSS("resize", "none");
    await expect(secondPromptInput).toHaveCSS("overflow-y", "auto");
    const secondPromptResizeHandle = form.getByTestId(
      "task-workflow-form-step-prompt-input-1-resize-handle",
    );
    await expect(secondPromptResizeHandle).toHaveCount(1);
    // The grip hangs below its input, so scrolling the input into view can still
    // leave the thing being dragged under the pane's bottom edge.
    await secondPromptResizeHandle.scrollIntoViewIfNeeded();
    const secondBeforeResize = await secondPromptInput.boundingBox();
    const secondResizeHandleBox = await secondPromptResizeHandle.boundingBox();
    if (!secondBeforeResize) throw new Error("Second agent brief is not laid out");
    if (!secondResizeHandleBox) throw new Error("Second agent brief resize handle is not laid out");
    await page.mouse.move(
      secondResizeHandleBox.x + secondResizeHandleBox.width / 2,
      secondResizeHandleBox.y + secondResizeHandleBox.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      secondResizeHandleBox.x + secondResizeHandleBox.width / 2,
      secondResizeHandleBox.y + secondResizeHandleBox.height / 2 + 80,
    );
    await page.mouse.up();
    await expect
      .poll(async () => (await secondPromptInput.boundingBox())?.height ?? 0)
      .toBeGreaterThan(secondBeforeResize.height + 40);
  });

  /** A preset is what everything that starts work reads from — including
   * review — so being unable to make one leaves all of it dead. A card with no
   * plan on it still just moves: a preset on the board is not an instruction to
   * run one. */
  test("creates a preset and moves a planless card without starting anything", async ({ page }) => {
    const workspace = await seedWorkspace({ repoPrefix: "kanban-preset-" });
    cleanupTasks.push(() => workspace.cleanup());
    const seeded = await seedTrackerTask(workspace, `Preset task ${Date.now()}`);

    await openBoard(page, seeded.projectId);
    await page.getByTestId(`kanban-board-menu-${seeded.projectId}`).click();
    await page.getByTestId(`kanban-presets-${seeded.projectId}`).click();

    const sheet = page.getByTestId("task-presets-sheet");
    await expect(sheet).toBeVisible({ timeout: 10_000 });
    const presetName = `Implementer ${Date.now()}`;
    await page.getByTestId("task-presets-name-input").fill(presetName);
    await page.getByTestId("task-presets-agent-trigger").click();
    const modelOption = page.locator('[data-testid^="model-option-"]').first();
    if (!(await modelOption.isVisible().catch(() => false))) {
      await page.locator('[data-testid^="model-provider-"]').first().click();
    }
    await expect(modelOption).toBeVisible({ timeout: 10_000 });
    await modelOption.click();
    await page.getByTestId("task-presets-save").click();
    await expect(sheet).toContainText(presetName, { timeout: 30_000 });
    await page.keyboard.press("Escape");

    const board = page.getByTestId(`kanban-board-${seeded.projectId}`);
    await page.getByTestId(`task-card-status-${seeded.taskId}`).click();
    await page.getByTestId(`task-card-status-${seeded.taskId}-in_progress`).click();

    await expect(board.getByTestId("task-column-in_progress")).toContainText(`Preset task`, {
      timeout: 30_000,
    });
    // Nothing asked, nothing started — and the card carries the offer to plan it.
    await expect(page.getByTestId(`task-card-add-plan-${seeded.taskId}`)).toBeVisible({
      timeout: 10_000,
    });
  });

  test("reports the failure when a confirmed plan starts on landing in Working", async ({
    page,
  }) => {
    const workspace = await seedWorkspace({ repoPrefix: "kanban-start-failure-" });
    cleanupTasks.push(() => workspace.cleanup());
    const seeded = await seedTrackerTask(workspace, `Failed start ${Date.now()}`);
    const workflow = await trackerClient(workspace).tasksWorkflowSet({
      taskId: seeded.taskId,
      steps: [
        {
          name: "Implement",
          prompt: "Do the work",
          agents: [{ provider: "claude" }],
          completion: "all",
          workspace: { mode: "existing", workspaceId: "missing-workspace" },
          trigger: { type: "manual" },
        },
      ],
    });
    if (workflow.error) throw new Error(workflow.error);

    await openBoard(page, seeded.projectId);
    const board = page.getByTestId(`kanban-board-${seeded.projectId}`);
    const confirmations: string[] = [];
    page.on("dialog", (dialog) => {
      confirmations.push(dialog.message());
      void dialog.accept();
    });
    await page.getByTestId(`task-card-status-${seeded.taskId}`).click();
    await page.getByTestId(`task-card-status-${seeded.taskId}-in_progress`).click();

    // The card's own plan is what is offered — no provider to pick.
    await expect.poll(() => confirmations.join("\n"), { timeout: 10_000 }).toContain("Implement");
    await expect(page.getByTestId("app-toast-message")).toContainText("Workspace not found", {
      timeout: 10_000,
    });
    // The move stands on its own: a step that could not dispatch does not take
    // the card back out of Working.
    await expect(board.getByTestId("task-column-in_progress")).toContainText("Failed start", {
      timeout: 30_000,
    });
  });

  /** Declining is the whole point of the confirmation: the card stays where it
   * was dropped and no agent is dispatched. */
  test("leaves the card moved and idle when the start is declined", async ({ page }) => {
    const workspace = await seedWorkspace({ repoPrefix: "kanban-start-declined-" });
    cleanupTasks.push(() => workspace.cleanup());
    const seeded = await seedTrackerTask(workspace, `Declined start ${Date.now()}`);
    const workflow = await trackerClient(workspace).tasksWorkflowSet({
      taskId: seeded.taskId,
      steps: [
        {
          name: "Implement",
          prompt: "Do the work",
          agents: [{ provider: "claude" }],
          completion: "all",
          workspace: { mode: "existing", workspaceId: "missing-workspace" },
          trigger: { type: "manual" },
        },
      ],
    });
    if (workflow.error) throw new Error(workflow.error);

    await openBoard(page, seeded.projectId);
    const board = page.getByTestId(`kanban-board-${seeded.projectId}`);
    page.on("dialog", (dialog) => void dialog.dismiss());
    await page.getByTestId(`task-card-status-${seeded.taskId}`).click();
    await page.getByTestId(`task-card-status-${seeded.taskId}-in_progress`).click();

    await expect(board.getByTestId("task-column-in_progress")).toContainText("Declined start", {
      timeout: 30_000,
    });
    await expect(page.getByTestId("app-toast-message")).toHaveCount(0);
  });

  test("the feed composer records a board note without mention actions", async ({ page }) => {
    const workspace = await seedWorkspace({ repoPrefix: "kanban-note-" });
    cleanupTasks.push(() => workspace.cleanup());
    const seeded = await seedTrackerTask(workspace, `Note task ${Date.now()}`);

    await openBoard(page, seeded.projectId);
    const feed = page.getByTestId("board-feed-pane");
    if (!(await feed.isVisible())) {
      await page.getByTestId("board-feed-toggle").click();
    }
    await expect(feed).toBeVisible({ timeout: 10_000 });

    const note = `Board note ${Date.now()}`;
    await page.getByTestId("board-feed-composer-input").fill(note);
    await page.getByTestId("board-feed-send").click();
    await expect(feed).toContainText(note, { timeout: 30_000 });
  });

  /** A press always opens the card, whatever is attached to it. The old rule —
   * open the chat when exactly one agent is attached, do nothing otherwise —
   * was one no user could learn. */
  test("pressing a card opens its details and takes an update", async ({ page }) => {
    const workspace = await seedWorkspace({ repoPrefix: "kanban-detail-" });
    cleanupTasks.push(() => workspace.cleanup());
    const title = `Detail task ${Date.now()}`;
    const seeded = await seedTrackerTask(workspace, title);

    await openBoard(page, seeded.projectId);
    const board = page.getByTestId(`kanban-board-${seeded.projectId}`);
    await board.getByTestId(`task-card-${seeded.taskId}`).click();

    const sheet = page.getByTestId("task-detail-sheet");
    await expect(sheet).toBeVisible({ timeout: 10_000 });
    await expect(sheet.getByTestId("task-detail-title-input")).toHaveValue(title);

    const note = `Update ${Date.now()}`;
    await sheet.getByTestId("task-detail-tab-activity").click();
    await sheet.getByTestId("task-detail-composer-note").click();
    await sheet.getByTestId("task-detail-note-input").fill(note);
    await sheet.getByTestId("task-detail-note-send").click();
    await expect(sheet).toContainText(note, { timeout: 30_000 });
  });

  test("edits a due date from the task-detail quick property", async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("@paseo:app-settings", JSON.stringify({ theme: "dark" }));
    });
    const workspace = await seedWorkspace({ repoPrefix: "kanban-task-due-date-" });
    cleanupTasks.push(() => workspace.cleanup());
    const seeded = await seedTrackerTask(workspace, `Due date task ${Date.now()}`);

    await openBoard(page, seeded.projectId);
    await page.getByTestId(`task-card-${seeded.taskId}`).click();
    const sheet = page.getByTestId("task-detail-sheet");
    await expect(sheet).toBeVisible({ timeout: 10_000 });

    await expect(sheet.getByTestId("task-detail-status-trigger")).toBeVisible();
    await expect(sheet.getByTestId("task-detail-priority-trigger")).toBeVisible();
    await expect(sheet.getByTestId("task-detail-labels-trigger")).toBeVisible();

    const dueTrigger = sheet.getByTestId("task-detail-due-trigger");
    await expect(dueTrigger).toContainText("+ Due");
    await dueTrigger.click();
    const dueMenu = page.getByTestId("task-due-menu");
    await expect(dueMenu.getByText("Today", { exact: true })).toBeVisible();
    await expect(dueMenu.getByText("Tomorrow", { exact: true })).toBeVisible();
    await expect(dueMenu.getByText("Next week", { exact: true })).toBeVisible();
    await expect(dueMenu.getByText("Custom", { exact: true })).toBeVisible();
    await expect(dueMenu.getByText("Clear", { exact: true })).toBeVisible();

    const today = await page.evaluate(() => {
      const now = new Date();
      const year = String(now.getFullYear()).padStart(4, "0");
      const month = String(now.getMonth() + 1).padStart(2, "0");
      const day = String(now.getDate()).padStart(2, "0");
      return `${year}-${month}-${day}`;
    });
    await dueMenu.getByTestId("task-due-today").click();
    await expect(dueTrigger).toContainText(today, { timeout: 30_000 });
    await expect.poll(() => readTaskDueDate(workspace, seeded.taskId)).toBe(today);

    await dueTrigger.click();
    await page.getByTestId("task-due-custom").click();
    const customSheet = page.getByTestId("task-due-date-custom-sheet");
    await expect(customSheet).toBeVisible();
    const customInput = customSheet.getByTestId("task-due-date-custom-input");
    await expect(customInput).toHaveCSS("color-scheme", "dark");
    await customInput.fill("2031-06-14");
    await customSheet.getByTestId("task-due-date-custom-save").click();
    await expect(customSheet).toHaveCount(0);
    await expect(dueTrigger).toContainText("2031-06-14", { timeout: 30_000 });
    await expect.poll(() => readTaskDueDate(workspace, seeded.taskId)).toBe("2031-06-14");

    await dueTrigger.click();
    await page.getByTestId("task-due-clear").click();
    await expect(dueTrigger).toContainText("+ Due", { timeout: 30_000 });
    await expect.poll(() => readTaskDueDate(workspace, seeded.taskId)).toBeNull();
  });

  test("a task edits its agent brief, automation, and subtask execution order", async ({
    page,
  }) => {
    const workspace = await seedWorkspace({ repoPrefix: "kanban-task-policy-" });
    cleanupTasks.push(() => workspace.cleanup());
    const seeded = await seedTrackerTask(workspace, `Policy task ${Date.now()}`);

    await openBoard(page, seeded.projectId);
    await page.getByTestId(`task-card-${seeded.taskId}`).click();
    const sheet = page.getByTestId("task-detail-sheet");
    await expect(sheet).toBeVisible({ timeout: 10_000 });

    const executionTabLabel = sheet.getByTestId("task-detail-tab-execution").getByText("Execution");
    const detailsTabLabel = sheet.getByTestId("task-detail-tab-details").getByText("Details");
    const activityTabLabel = sheet.getByTestId("task-detail-tab-activity").getByText("Activity");
    await expect(executionTabLabel).toHaveCSS("font-weight", "400");
    await expect(detailsTabLabel).toHaveCSS("font-weight", "400");
    await expect(activityTabLabel).toHaveCSS("font-weight", "400");

    const planHeading = sheet.getByTestId("task-detail-workflow").getByText("Plan", {
      exact: true,
    });
    await expect(planHeading).toHaveCSS("font-weight", "600");
    const [executionTabBox, planHeadingBox] = await Promise.all([
      executionTabLabel.boundingBox(),
      planHeading.boundingBox(),
    ]);
    if (!executionTabBox || !planHeadingBox) {
      throw new Error("Task detail navigation and section headings are not laid out");
    }
    expect(Math.abs(executionTabBox.x - planHeadingBox.x)).toBeLessThanOrEqual(1);

    const refinedTitle = `Refined outcome ${Date.now()}`;
    await sheet.getByTestId("task-detail-title-input").fill(refinedTitle);
    await sheet.getByTestId("task-detail-tab-details").click();
    const briefHeading = sheet.getByText("Brief", { exact: true });
    const detailsSubtaskHeading = sheet.getByText("Subtasks", { exact: true });
    await expect(briefHeading).toHaveCSS("font-size", "14px");
    await expect(briefHeading).toHaveCSS("font-weight", "600");
    await expect(detailsSubtaskHeading).toHaveCSS("font-size", "14px");
    await expect(sheet.getByText("Breakdown", { exact: true })).toHaveCount(0);
    const [briefHeadingBox, detailsSubtaskHeadingBox] = await Promise.all([
      briefHeading.boundingBox(),
      detailsSubtaskHeading.boundingBox(),
    ]);
    if (!briefHeadingBox || !detailsSubtaskHeadingBox) {
      throw new Error("Task detail headings are not laid out");
    }
    expect(Math.abs(planHeadingBox.x - briefHeadingBox.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(planHeadingBox.x - detailsSubtaskHeadingBox.x)).toBeLessThanOrEqual(1);
    await sheet
      .getByTestId("task-detail-description-input")
      .fill("Implement this outcome with the constraints in the task.");
    await sheet.getByTestId("task-detail-automation-change").click();
    // A leaf task's review is a switch: the board leaves it off, so one press
    // is what requires it on this task.
    await sheet.getByTestId("task-detail-policy-review").click();
    await sheet.getByTestId("task-detail-policy-workspace").click();
    await page.getByTestId("task-detail-policy-workspace-dedicated").click();
    await expect
      .poll(() => readTaskBriefAndPolicy(workspace, seeded.taskId))
      .toEqual({
        title: refinedTitle,
        description: "Implement this outcome with the constraints in the task.",
        policy: { review: "required", workspace: "dedicated" },
      });

    await sheet.getByTestId("sheet-header-back").click();
    await sheet.getByTestId("task-detail-tab-details").click();
    const firstTitle = `First child ${Date.now()}`;
    await sheet.getByTestId("task-detail-subtask-input").fill(firstTitle);
    await sheet.getByTestId("task-detail-subtask-add").click();
    await expect
      .poll(() => hasSubtask(workspace, { parentTaskId: seeded.taskId, title: firstTitle }))
      .toBe(true);

    const secondTitle = `Second child ${Date.now()}`;
    await sheet.getByTestId("task-detail-subtask-input").fill(secondTitle);
    await sheet.getByTestId("task-detail-subtask-add").click();
    await expect
      .poll(() =>
        hasDependencyBetweenTitles(workspace, {
          blockedTitle: secondTitle,
          blockerTitle: firstTitle,
        }),
      )
      .toBe(true);

    const subtaskHeading = sheet.getByText("Subtasks", { exact: true });
    await expect(subtaskHeading).toHaveCount(1);
    await expect(subtaskHeading).toHaveCSS("font-weight", "600");
    const subtaskHeadingBox = await subtaskHeading.boundingBox();
    if (!subtaskHeadingBox) throw new Error("Subtasks heading is not laid out");
    expect(Math.abs(planHeadingBox.x - subtaskHeadingBox.x)).toBeLessThanOrEqual(1);
  });

  test("a task manages project labels from its label dropdown", async ({ page }) => {
    const workspace = await seedWorkspace({ repoPrefix: "kanban-task-labels-" });
    cleanupTasks.push(() => workspace.cleanup());
    const seeded = await seedTrackerTask(workspace, `Label task ${Date.now()}`);

    await openBoard(page, seeded.projectId);
    await page.getByTestId(`task-card-${seeded.taskId}`).click();
    const sheet = page.getByTestId("task-detail-sheet");
    const trigger = sheet.getByTestId("task-detail-labels-trigger");
    const labelName = `Needs review ${Date.now()}`;

    await trigger.click();
    await page.getByTestId("task-label-create").click();
    await page.getByTestId("task-label-name").fill(labelName);
    await page.getByTestId("task-label-color-orange").click();
    await page.getByTestId("task-label-create-submit").click();
    await expect(trigger).toContainText(labelName, { timeout: 30_000 });

    const labelItem = page.locator('[data-testid^="task-label-tlbl_"]').filter({
      hasText: labelName,
    });
    await labelItem.click();
    await expect(trigger).toContainText("+ Label", { timeout: 30_000 });
    await labelItem.click();
    await expect(trigger).toContainText(labelName, { timeout: 30_000 });

    await page.getByTestId("task-label-delete").click();
    page.once("dialog", (dialog) => dialog.accept());
    await page
      .locator('[data-testid^="task-label-delete-tlbl_"]')
      .filter({
        hasText: labelName,
      })
      .click();
    await expect(trigger).toContainText("+ Label", { timeout: 30_000 });
  });

  /** The feed is where an automatic move says what it did, and where a note you
   * type at the board lands — one channel, both kinds of entry. */
  test("the board feed records an automatic move and takes a note", async ({ page }) => {
    const workspace = await seedWorkspace({ repoPrefix: "kanban-feed-" });
    cleanupTasks.push(() => workspace.cleanup());
    const seeded = await seedTrackerTask(workspace, `Feed task ${Date.now()}`, "in_review");

    await openBoard(page, seeded.projectId);
    const board = page.getByTestId(`kanban-board-${seeded.projectId}`);
    await expect(board.getByTestId(`task-card-${seeded.taskId}`)).toBeVisible({ timeout: 30_000 });

    await page.getByTestId(`task-card-status-${seeded.taskId}`).click();
    await page.getByTestId(`task-card-approve-${seeded.taskId}`).click();
    await expect
      .poll(() => readTaskStatus(workspace, seeded.taskId), { timeout: 30_000 })
      .toBe("done");

    // The sidebar is open by default on desktop, so this toggles it into view
    // only when something (a persisted panel state) had closed it.
    const feed = page.getByTestId("board-feed-pane");
    if (!(await feed.isVisible())) {
      await page.getByTestId("board-feed-toggle").click();
    }
    await expect(feed).toBeVisible({ timeout: 10_000 });
    await expect(feed).toContainText("was approved and moved to done", { timeout: 30_000 });

    const note = `Typed at the board ${Date.now()}`;
    await page.getByTestId("board-feed-composer-input").fill(note);
    await page.getByTestId("board-feed-send").click();
    await expect(feed).toContainText(note, { timeout: 30_000 });
  });

  /** Collapsed is the default: an aggregate's children are drawn under its own
   * card, in its own column, whatever their stored status is. The stored
   * status is still the only column truth, so a done child collapsed under a
   * working parent counts in Done without a card of its own there. */
  test("collapses an aggregate's children under its card and counts their stored statuses", async ({
    page,
  }) => {
    const workspace = await seedWorkspace({ repoPrefix: "kanban-aggregate-collapse-" });
    cleanupTasks.push(() => workspace.cleanup());
    const parentTitle = `Aggregate parent ${Date.now()}`;
    const parent = await seedTrackerTask(workspace, parentTitle, "in_progress");
    // A second, still-running child keeps the parent in Working once the first
    // one merges — otherwise the last subtask settling would also settle the
    // parent, and there would be no working parent left to collapse under.
    const runningChildTitle = `Aggregate running child ${Date.now()}`;
    const runningChild = await seedSubtask(workspace, {
      projectId: parent.projectId,
      parentTaskId: parent.taskId,
      title: runningChildTitle,
      status: "in_progress",
    });
    const childTitle = `Aggregate child ${Date.now()}`;
    const child = await seedSubtask(workspace, {
      projectId: parent.projectId,
      parentTaskId: parent.taskId,
      title: childTitle,
      status: "in_review",
    });

    await openBoard(page, parent.projectId);
    const board = page.getByTestId(`kanban-board-${parent.projectId}`);
    const parentCard = board.getByTestId(`task-card-${parent.taskId}`);
    await expect(parentCard).toBeVisible({ timeout: 30_000 });

    // A tracker-only child merges without a worktree: approving it is what
    // gets it to Done, the same completion gate as any other subtask.
    const inProgressBody = board.getByTestId("task-column-body-in_progress");
    await inProgressBody.getByTestId(`task-card-status-${child.taskId}`).click();
    await page.getByTestId(`task-card-approve-${child.taskId}`).click();
    await expect
      .poll(() => readTaskStatus(workspace, child.taskId), { timeout: 30_000 })
      .toBe("done");
    // The running sibling kept the parent out of the aggregation transition.
    await expect
      .poll(() => readTaskStatus(workspace, parent.taskId), { timeout: 10_000 })
      .toBe("in_progress");

    // Collapsed: the merged child is drawn nested under the parent in the
    // parent's own column, not as a card of its own in Done.
    await expect(inProgressBody.getByTestId(`task-card-${child.taskId}`)).toBeVisible();
    await expect(inProgressBody.getByTestId(`task-card-${runningChild.taskId}`)).toBeVisible();
    await expect(
      board.getByTestId("task-column-body-done").getByTestId(`task-card-${child.taskId}`),
    ).toHaveCount(0);
    await expect(parentCard.getByTestId(`task-card-child-states-${parent.taskId}`)).toContainText(
      "1 running",
    );
    await expect(parentCard.getByTestId(`task-card-child-states-${parent.taskId}`)).toContainText(
      "1 done",
    );
    // The stored status is the only column truth: Done's badge counts the
    // child even though nothing is drawn in Done's own body.
    await expect(board.getByTestId("task-column-done")).toContainText("1");

    // Expanding puts every task in its own status column, and the choice
    // persists per board.
    await board.getByTestId("task-board-subtasks-projection").click();
    await expect(
      board.getByTestId("task-column-body-done").getByTestId(`task-card-${child.taskId}`),
    ).toBeVisible({ timeout: 10_000 });
    await expect(inProgressBody.getByTestId(`task-card-${child.taskId}`)).toHaveCount(0);

    await page.reload();
    await waitForSidebarHydration(page);
    const reloadedBoard = page.getByTestId(`kanban-board-${parent.projectId}`);
    await expect(
      reloadedBoard.getByTestId("task-column-body-done").getByTestId(`task-card-${child.taskId}`),
    ).toBeVisible({ timeout: 30_000 });
    await expect(reloadedBoard.getByTestId("task-board-subtasks-projection")).toContainText(
      "Subtasks in columns",
    );
  });

  test("consuming a task query does not reopen the task after reload", async ({ page }) => {
    const workspace = await seedWorkspace({ repoPrefix: "kanban-task-query-" });
    cleanupTasks.push(() => workspace.cleanup());
    const title = `Query task ${Date.now()}`;
    const seeded = await seedTrackerTask(workspace, title);

    await openKanbans(page);
    await page.getByTestId(`task-board-overview-card-${seeded.taskId}`).click();
    await expect(page.getByTestId("task-detail-sheet")).toBeVisible({ timeout: 30_000 });
    await expect(page).toHaveURL(new RegExp(`/kanbans/${seeded.projectId}$`));

    await page.getByTestId("task-detail-sheet").getByRole("button", { name: "Close" }).click();
    await page.reload();
    await expect(page.getByTestId("task-detail-sheet")).toHaveCount(0);
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
