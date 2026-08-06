import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { StoredKanbanSchema, type StoredKanban } from "@getpaseo/protocol/kanban/types";
import { writeJsonFileAtomic } from "../atomic-file.js";

const MAX_RUNS_PER_STEP = 20;

function generateKanbanId(): string {
  return `kbn_${randomBytes(4).toString("hex")}`;
}

type KanbanUpdater = (kanban: StoredKanban) => StoredKanban | Promise<StoredKanban>;

// Step run history grows without bound as agents execute; capping it here (instead
// of at every call site) keeps the persisted file size predictable regardless of
// which code path wrote the kanban.
function capStepRuns(kanban: StoredKanban): StoredKanban {
  const plans = Object.fromEntries(
    Object.entries(kanban.plans).map(([planId, plan]) => [planId, capPlanRuns(plan)]),
  );
  return { ...kanban, plans };
}

function capPlanRuns<T extends StoredKanban["plans"][string]>(plan: T): T {
  if (plan.body.type === "workflow") {
    return {
      ...plan,
      body: {
        ...plan.body,
        steps: plan.body.steps.map((step) => ({
          ...step,
          runs: step.runs.slice(-MAX_RUNS_PER_STEP),
        })),
      },
    };
  }
  return {
    ...plan,
    body: {
      ...plan.body,
      plans: Object.fromEntries(
        Object.entries(plan.body.plans).map(([nestedId, nestedPlan]) => [
          nestedId,
          capPlanRuns(nestedPlan),
        ]),
      ),
    },
  };
}

export class KanbanStore {
  private readonly kanbanMutations = new Map<string, Promise<unknown>>();

  constructor(private readonly dir: string) {}

  private filePath(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  private async ensureDir(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  async list(): Promise<StoredKanban[]> {
    await this.ensureDir();
    const entries = await readdir(this.dir, { withFileTypes: true });
    const kanbans = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map(async (entry) => {
          const content = await readFile(join(this.dir, entry.name), "utf-8");
          return StoredKanbanSchema.parse(JSON.parse(content));
        }),
    );
    return kanbans.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async get(id: string): Promise<StoredKanban | null> {
    await this.ensureDir();
    try {
      const content = await readFile(this.filePath(id), "utf-8");
      return StoredKanbanSchema.parse(JSON.parse(content));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  async create(kanban: Omit<StoredKanban, "id">): Promise<StoredKanban> {
    const parsed = StoredKanbanSchema.parse({ ...kanban, id: generateKanbanId() });
    const created = capStepRuns(parsed);
    await this.write(created);
    return created;
  }

  async update(id: string, updater: KanbanUpdater): Promise<StoredKanban | null> {
    return this.serializeMutation(id, async () => {
      const current = await this.get(id);
      if (!current) {
        return null;
      }
      const next = await updater(current);
      if (next.id !== id) {
        throw new Error(`Kanban update cannot change id: ${id}`);
      }
      const updated = capStepRuns(StoredKanbanSchema.parse(next));
      await this.write(updated);
      return updated;
    });
  }

  async delete(id: string): Promise<void> {
    await this.serializeMutation(id, async () => {
      await this.ensureDir();
      await rm(this.filePath(id), { force: true });
    });
  }

  private async write(kanban: StoredKanban): Promise<void> {
    await this.ensureDir();
    await writeJsonFileAtomic(this.filePath(kanban.id), kanban);
  }

  private async serializeMutation<T>(key: string, mutation: () => Promise<T>): Promise<T> {
    const previous = this.kanbanMutations.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(mutation);
    this.kanbanMutations.set(key, next);
    try {
      return await next;
    } finally {
      if (this.kanbanMutations.get(key) === next) {
        this.kanbanMutations.delete(key);
      }
    }
  }
}
