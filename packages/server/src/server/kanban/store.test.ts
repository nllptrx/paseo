import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { StoredKanban, Step } from "@getpaseo/protocol/kanban/types";
import { KanbanStore } from "./store.js";

function makeStep(overrides: Partial<Step> = {}): Step {
  return {
    id: "stp_00000001",
    name: "Step 1",
    prompt: "Do the thing",
    agents: [{ provider: "claude" }],
    completion: "all",
    workspace: { mode: "worktree" },
    trigger: { type: "immediate" },
    runs: [],
    ...overrides,
  };
}

function makeKanban(overrides: Partial<Omit<StoredKanban, "id">> = {}): Omit<StoredKanban, "id"> {
  return {
    projectId: "proj-1",
    name: "Project board",
    autoAdvance: false,
    orchestrator: null,
    columns: [
      {
        id: "col_backlog",
        name: "Backlog",
        role: "backlog",
        onCardEnter: "none",
        archiveWorkspacesOnEnter: false,
        planIds: [],
      },
    ],
    plans: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    archivedAt: null,
    ...overrides,
  };
}

describe("KanbanStore", () => {
  let tempDir: string;
  let store: KanbanStore;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "kanban-store-test-"));
    store = new KanbanStore(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("creates and reloads kanbans from disk", async () => {
    const created = await store.create(makeKanban());

    const reloaded = new KanbanStore(tempDir);
    const listed = await reloaded.list();

    expect(created.id).toMatch(/^kbn_[0-9a-f]{8}$/);
    expect(listed).toEqual([created]);
  });

  test("update round-trips an updated kanban to disk", async () => {
    const created = await store.create(makeKanban());

    await store.update(created.id, (kanban) => ({
      ...kanban,
      name: "Renamed board",
      updatedAt: "2026-01-01T00:01:00.000Z",
    }));

    const reloaded = await new KanbanStore(tempDir).get(created.id);
    expect(reloaded).toMatchObject({ name: "Renamed board" });
  });

  test("archive semantics: update sets archivedAt, get returns it", async () => {
    const created = await store.create(makeKanban());
    expect(created.archivedAt).toBeNull();

    await store.update(created.id, (kanban) => ({
      ...kanban,
      archivedAt: "2026-01-01T00:02:00.000Z",
    }));

    const reloaded = await store.get(created.id);
    expect(reloaded?.archivedAt).toBe("2026-01-01T00:02:00.000Z");
  });

  test("caps a step's runs to the most recent 20", async () => {
    const runs = Array.from({ length: 25 }, (_, index) => ({
      id: `run-${index}`,
      startedAt: `2026-01-01T00:${String(index).padStart(2, "0")}:00.000Z`,
      endedAt: null,
      status: "running" as const,
      agentIds: [],
      workspaceIds: [],
      scheduleId: null,
      error: null,
    }));

    const created = await store.create(
      makeKanban({
        plans: {
          pln_00000001: {
            id: "pln_00000001",
            title: "Plan 1",
            description: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            archivedAt: null,
            lastMove: null,
            body: {
              type: "workflow",
              steps: [makeStep({ runs })],
            },
          },
        },
      }),
    );

    const stepAfterCreate = created.plans.pln_00000001.body;
    if (stepAfterCreate.type !== "workflow") throw new Error("expected workflow body");
    expect(stepAfterCreate.steps[0].runs).toHaveLength(20);
    expect(stepAfterCreate.steps[0].runs[0].id).toBe("run-5");
    expect(stepAfterCreate.steps[0].runs[19].id).toBe("run-24");

    const reloaded = await store.get(created.id);
    const stepAfterReload = reloaded?.plans.pln_00000001.body;
    if (!stepAfterReload || stepAfterReload.type !== "workflow") {
      throw new Error("expected workflow body");
    }
    expect(stepAfterReload.steps[0].runs).toHaveLength(20);
  });

  test("serializes concurrent updates on one kanban without losing writes", async () => {
    const created = await store.create(makeKanban());

    let releaseFirstUpdate: (() => void) | null = null;
    const firstUpdateBlocked = new Promise<void>((resolve) => {
      releaseFirstUpdate = resolve;
    });
    let firstUpdaterEntered: (() => void) | null = null;
    const firstUpdaterStarted = new Promise<void>((resolve) => {
      firstUpdaterEntered = resolve;
    });
    let secondSawName = "";

    const firstUpdate = store.update(created.id, async (kanban) => {
      firstUpdaterEntered?.();
      await firstUpdateBlocked;
      return { ...kanban, name: "first" };
    });
    await firstUpdaterStarted;

    const secondUpdate = store.update(created.id, (kanban) => {
      secondSawName = kanban.name;
      return { ...kanban, autoAdvance: true };
    });

    releaseFirstUpdate?.();
    const [, second] = await Promise.all([firstUpdate, secondUpdate]);

    expect(secondSawName).toBe("first");
    expect(second).toMatchObject({ name: "first", autoAdvance: true });
    await expect(new KanbanStore(tempDir).get(created.id)).resolves.toMatchObject({
      name: "first",
      autoAdvance: true,
    });
  });

  test("deletes kanbans from disk", async () => {
    const created = await store.create(makeKanban());

    await store.delete(created.id);

    expect(await store.get(created.id)).toBeNull();
    expect(await store.list()).toEqual([]);
  });
});
