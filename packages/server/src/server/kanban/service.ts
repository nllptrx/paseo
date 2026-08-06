import { randomBytes } from "node:crypto";
import type pino from "pino";
import type {
  Column,
  KanbanPlan,
  KanbanSummary,
  NestedPlan,
  Step,
  StoredKanban,
} from "@getpaseo/protocol/kanban/types";
import type { OrchestratorPeer } from "@getpaseo/protocol/kanban/rpc-schemas";
import { KanbanStore } from "./store.js";

type ColumnInput = Omit<Column, "id" | "planIds">;
type StepInput = Omit<Step, "id" | "runs">;

type KanbanPlanCreateBody =
  | { type: "workflow"; steps: StepInput[] }
  | { type: "nested_kanban"; columns?: ColumnInput[] };

export interface KanbanServiceOptions {
  store: KanbanStore;
  logger: pino.Logger;
}

export type KanbanChangeEvent =
  | { kind: "upsert"; kanban: StoredKanban }
  | { kind: "remove"; kanbanId: string };

type KanbanChangeListener = (event: KanbanChangeEvent) => void;

function generateColumnId(): string {
  return `col_${randomBytes(4).toString("hex")}`;
}

function generatePlanId(): string {
  return `pln_${randomBytes(4).toString("hex")}`;
}

function generateStepId(): string {
  return `stp_${randomBytes(4).toString("hex")}`;
}

function buildDefaultColumns(): Column[] {
  return [
    {
      id: generateColumnId(),
      name: "Backlog",
      role: "backlog",
      onCardEnter: "none",
      archiveWorkspacesOnEnter: false,
      planIds: [],
    },
    {
      id: generateColumnId(),
      name: "In progress",
      role: "active",
      onCardEnter: "start",
      archiveWorkspacesOnEnter: false,
      planIds: [],
    },
    {
      id: generateColumnId(),
      name: "Review",
      role: "review",
      onCardEnter: "none",
      archiveWorkspacesOnEnter: false,
      planIds: [],
    },
    {
      id: generateColumnId(),
      name: "Done",
      role: "done",
      onCardEnter: "none",
      archiveWorkspacesOnEnter: false,
      planIds: [],
    },
  ];
}

function buildColumnsFromInput(inputs: ColumnInput[]): Column[] {
  return inputs.map((input) => ({
    ...input,
    id: generateColumnId(),
    planIds: [],
  }));
}

function stampSteps(steps: StepInput[]): Step[] {
  return steps.map((step) => ({
    ...step,
    id: generateStepId(),
    runs: [],
  }));
}

function toKanbanSummary(kanban: StoredKanban): KanbanSummary {
  const { plans: _plans, ...summary } = kanban;
  return summary;
}

function requireKanban(kanban: StoredKanban | null, kanbanId: string): StoredKanban {
  if (!kanban) {
    throw new Error(`Kanban not found: ${kanbanId}`);
  }
  return kanban;
}

function requireActiveKanban(kanban: StoredKanban | null, kanbanId: string): StoredKanban {
  const found = requireKanban(kanban, kanbanId);
  if (found.archivedAt) {
    throw new Error(`Kanban is archived: ${kanbanId}`);
  }
  return found;
}

function findTopLevelPlan(kanban: StoredKanban, planId: string): KanbanPlan {
  const plan = kanban.plans[planId];
  if (!plan) {
    throw new Error(`Plan not found: ${planId}`);
  }
  return plan;
}

function findNestedParentPlan(kanban: StoredKanban, parentPlanId: string): KanbanPlan {
  const parent = findTopLevelPlan(kanban, parentPlanId);
  if (parent.body.type !== "nested_kanban") {
    throw new Error(`Plan is not a nested kanban: ${parentPlanId}`);
  }
  return parent;
}

function findNestedPlan(kanban: StoredKanban, parentPlanId: string, planId: string): NestedPlan {
  const parent = findNestedParentPlan(kanban, parentPlanId);
  const plan = parent.body.type === "nested_kanban" ? parent.body.plans[planId] : undefined;
  if (!plan) {
    throw new Error(`Nested plan not found: ${planId}`);
  }
  return plan;
}

function findColumnsForScope(
  kanban: StoredKanban,
  parentPlanId: string | null | undefined,
): Column[] {
  if (!parentPlanId) {
    return kanban.columns;
  }
  const parent = findNestedParentPlan(kanban, parentPlanId);
  return parent.body.type === "nested_kanban" ? parent.body.columns : [];
}

function requireColumnExists(columns: Column[], columnId: string): void {
  if (!columns.some((column) => column.id === columnId)) {
    throw new Error(`Column not found: ${columnId}`);
  }
}

// KanbanService is the single write-path into the kanban store: every mutation
// runs through here so onChange listeners always see a consistent, fully
// validated StoredKanban after each call.
export class KanbanService {
  private readonly store: KanbanStore;
  private readonly logger: pino.Logger;
  private readonly listeners = new Set<KanbanChangeListener>();

  constructor(options: KanbanServiceOptions) {
    this.store = options.store;
    this.logger = options.logger.child({ module: "kanban-service" });
  }

  onChange(listener: KanbanChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notifyUpsert(kanban: StoredKanban): void {
    this.logger.debug({ kanbanId: kanban.id }, "Kanban changed");
    for (const listener of this.listeners) {
      listener({ kind: "upsert", kanban });
    }
  }

  async list(): Promise<KanbanSummary[]> {
    const kanbans = await this.store.list();
    return kanbans.map(toKanbanSummary);
  }

  async get(id: string): Promise<StoredKanban | null> {
    return this.store.get(id);
  }

  async getOrCreateForProject(
    projectId: string,
    opts?: { name?: string; columns?: ColumnInput[] },
  ): Promise<StoredKanban> {
    const existing = (await this.store.list()).find(
      (kanban) => kanban.projectId === projectId && !kanban.archivedAt,
    );
    if (existing) {
      return existing;
    }
    const now = new Date().toISOString();
    const created = await this.store.create({
      projectId,
      name: opts?.name?.trim() || "Kanban",
      autoAdvance: false,
      orchestrator: null,
      columns: opts?.columns ? buildColumnsFromInput(opts.columns) : buildDefaultColumns(),
      plans: {},
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    });
    this.notifyUpsert(created);
    return created;
  }

  async update(
    id: string,
    patch: { name?: string; autoAdvance?: boolean; columns?: Column[] },
  ): Promise<StoredKanban> {
    const updated = await this.store.update(id, (kanban) => {
      requireActiveKanban(kanban, id);
      return {
        ...kanban,
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.autoAdvance !== undefined ? { autoAdvance: patch.autoAdvance } : {}),
        ...(patch.columns !== undefined ? { columns: patch.columns } : {}),
        updatedAt: new Date().toISOString(),
      };
    });
    const result = requireKanban(updated, id);
    this.notifyUpsert(result);
    return result;
  }

  async archive(id: string): Promise<void> {
    const updated = await this.store.update(id, (kanban) => ({
      ...kanban,
      archivedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));
    const result = requireKanban(updated, id);
    this.notifyUpsert(result);
  }

  async createPlan(input: {
    kanbanId: string;
    parentPlanId?: string | null;
    columnId: string;
    title: string;
    description?: string | null;
    body: KanbanPlanCreateBody;
  }): Promise<KanbanPlan> {
    if (input.parentPlanId && input.body.type !== "workflow") {
      throw new Error("Plans nested inside a kanban card can only be workflows");
    }

    const now = new Date().toISOString();
    const planId = generatePlanId();
    let createdPlan: KanbanPlan | undefined;

    const updated = await this.store.update(input.kanbanId, (kanban) => {
      requireActiveKanban(kanban, input.kanbanId);
      const columns = findColumnsForScope(kanban, input.parentPlanId);
      requireColumnExists(columns, input.columnId);

      const body =
        input.body.type === "workflow"
          ? ({ type: "workflow" as const, steps: stampSteps(input.body.steps) } as const)
          : ({
              type: "nested_kanban" as const,
              columns: input.body.columns
                ? buildColumnsFromInput(input.body.columns)
                : buildDefaultColumns(),
              plans: {},
            } as const);

      const plan: KanbanPlan = {
        id: planId,
        title: input.title,
        description: input.description ?? null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        lastMove: null,
        body,
      };
      createdPlan = plan;

      if (!input.parentPlanId) {
        return {
          ...kanban,
          columns: kanban.columns.map((column) =>
            column.id === input.columnId
              ? { ...column, planIds: [...column.planIds, planId] }
              : column,
          ),
          plans: { ...kanban.plans, [planId]: plan },
          updatedAt: now,
        };
      }

      const parent = findNestedParentPlan(kanban, input.parentPlanId);
      if (parent.body.type !== "nested_kanban") {
        throw new Error(`Plan is not a nested kanban: ${input.parentPlanId}`);
      }
      const updatedParent: KanbanPlan = {
        ...parent,
        updatedAt: now,
        body: {
          ...parent.body,
          columns: parent.body.columns.map((column) =>
            column.id === input.columnId
              ? { ...column, planIds: [...column.planIds, planId] }
              : column,
          ),
          plans: { ...parent.body.plans, [planId]: plan as NestedPlan },
        },
      };
      return {
        ...kanban,
        plans: { ...kanban.plans, [input.parentPlanId]: updatedParent },
        updatedAt: now,
      };
    });

    const result = requireKanban(updated, input.kanbanId);
    this.notifyUpsert(result);
    if (!createdPlan) {
      throw new Error("Plan creation failed unexpectedly");
    }
    return createdPlan;
  }

  async updatePlan(input: {
    kanbanId: string;
    parentPlanId?: string | null;
    planId: string;
    title?: string;
    description?: string | null;
  }): Promise<KanbanPlan> {
    const now = new Date().toISOString();
    let updatedPlan: KanbanPlan | undefined;

    const updated = await this.store.update(input.kanbanId, (kanban) => {
      requireActiveKanban(kanban, input.kanbanId);

      if (!input.parentPlanId) {
        const plan = findTopLevelPlan(kanban, input.planId);
        const next: KanbanPlan = {
          ...plan,
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          updatedAt: now,
        };
        updatedPlan = next;
        return {
          ...kanban,
          plans: { ...kanban.plans, [input.planId]: next },
          updatedAt: now,
        };
      }

      const parent = findNestedParentPlan(kanban, input.parentPlanId);
      if (parent.body.type !== "nested_kanban") {
        throw new Error(`Plan is not a nested kanban: ${input.parentPlanId}`);
      }
      const nested = findNestedPlan(kanban, input.parentPlanId, input.planId);
      const next: NestedPlan = {
        ...nested,
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        updatedAt: now,
      };
      updatedPlan = next;
      const updatedParent: KanbanPlan = {
        ...parent,
        updatedAt: now,
        body: {
          ...parent.body,
          plans: { ...parent.body.plans, [input.planId]: next },
        },
      };
      return {
        ...kanban,
        plans: { ...kanban.plans, [input.parentPlanId]: updatedParent },
        updatedAt: now,
      };
    });

    const result = requireKanban(updated, input.kanbanId);
    this.notifyUpsert(result);
    if (!updatedPlan) {
      throw new Error("Plan update failed unexpectedly");
    }
    return updatedPlan;
  }

  async movePlan(input: {
    kanbanId: string;
    parentPlanId?: string | null;
    planId: string;
    columnId: string;
    index: number;
    movedBy: "user" | "agent";
  }): Promise<KanbanPlan> {
    const now = new Date().toISOString();
    let movedPlan: KanbanPlan | undefined;

    const updated = await this.store.update(input.kanbanId, (kanban) => {
      requireActiveKanban(kanban, input.kanbanId);
      const lastMove = { at: now, by: input.movedBy };

      if (!input.parentPlanId) {
        const plan = findTopLevelPlan(kanban, input.planId);
        requireColumnExists(kanban.columns, input.columnId);
        const columns = kanban.columns.map((column) => ({
          ...column,
          planIds: column.planIds.filter((id) => id !== input.planId),
        }));
        const targetIndex = kanban.columns.findIndex((column) => column.id === input.columnId);
        const target = columns[targetIndex];
        const clampedIndex = Math.max(0, Math.min(input.index, target.planIds.length));
        target.planIds.splice(clampedIndex, 0, input.planId);
        const next: KanbanPlan = { ...plan, lastMove, updatedAt: now };
        movedPlan = next;
        return {
          ...kanban,
          columns,
          plans: { ...kanban.plans, [input.planId]: next },
          updatedAt: now,
        };
      }

      const parent = findNestedParentPlan(kanban, input.parentPlanId);
      if (parent.body.type !== "nested_kanban") {
        throw new Error(`Plan is not a nested kanban: ${input.parentPlanId}`);
      }
      const nested = findNestedPlan(kanban, input.parentPlanId, input.planId);
      requireColumnExists(parent.body.columns, input.columnId);
      const columns = parent.body.columns.map((column) => ({
        ...column,
        planIds: column.planIds.filter((id) => id !== input.planId),
      }));
      const targetIndex = parent.body.columns.findIndex((column) => column.id === input.columnId);
      const target = columns[targetIndex];
      const clampedIndex = Math.max(0, Math.min(input.index, target.planIds.length));
      target.planIds.splice(clampedIndex, 0, input.planId);
      const next: NestedPlan = { ...nested, lastMove, updatedAt: now };
      movedPlan = next;
      const updatedParent: KanbanPlan = {
        ...parent,
        updatedAt: now,
        body: {
          ...parent.body,
          columns,
          plans: { ...parent.body.plans, [input.planId]: next },
        },
      };
      return {
        ...kanban,
        plans: { ...kanban.plans, [input.parentPlanId]: updatedParent },
        updatedAt: now,
      };
    });

    const result = requireKanban(updated, input.kanbanId);
    this.notifyUpsert(result);
    if (!movedPlan) {
      throw new Error("Plan move failed unexpectedly");
    }
    return movedPlan;
  }

  async archivePlan(input: {
    kanbanId: string;
    parentPlanId?: string | null;
    planId: string;
  }): Promise<void> {
    const now = new Date().toISOString();

    const updated = await this.store.update(input.kanbanId, (kanban) => {
      requireActiveKanban(kanban, input.kanbanId);

      if (!input.parentPlanId) {
        const plan = findTopLevelPlan(kanban, input.planId);
        return {
          ...kanban,
          plans: { ...kanban.plans, [input.planId]: { ...plan, archivedAt: now, updatedAt: now } },
          updatedAt: now,
        };
      }

      const parent = findNestedParentPlan(kanban, input.parentPlanId);
      if (parent.body.type !== "nested_kanban") {
        throw new Error(`Plan is not a nested kanban: ${input.parentPlanId}`);
      }
      const nested = findNestedPlan(kanban, input.parentPlanId, input.planId);
      const updatedParent: KanbanPlan = {
        ...parent,
        updatedAt: now,
        body: {
          ...parent.body,
          plans: {
            ...parent.body.plans,
            [input.planId]: { ...nested, archivedAt: now, updatedAt: now },
          },
        },
      };
      return {
        ...kanban,
        plans: { ...kanban.plans, [input.parentPlanId]: updatedParent },
        updatedAt: now,
      };
    });

    const result = requireKanban(updated, input.kanbanId);
    this.notifyUpsert(result);
  }

  // Pointer-only: stamps orchestrator = { workspaceId, agentId } without creating the
  // workspace or agent. Provisioning the actual control-plane workspace is a later slice.
  async provisionOrchestratorPointer(
    kanbanId: string,
    pointer: { workspaceId: string; agentId: string },
  ): Promise<StoredKanban> {
    const updated = await this.store.update(kanbanId, (kanban) => {
      requireActiveKanban(kanban, kanbanId);
      if (kanban.orchestrator) {
        throw new Error(`Kanban already has an orchestrator: ${kanbanId}`);
      }
      return {
        ...kanban,
        orchestrator: pointer,
        updatedAt: new Date().toISOString(),
      };
    });
    const result = requireKanban(updated, kanbanId);
    this.notifyUpsert(result);
    return result;
  }

  async unlinkOrchestrator(kanbanId: string): Promise<StoredKanban> {
    const updated = await this.store.update(kanbanId, (kanban) => ({
      ...kanban,
      orchestrator: null,
      updatedAt: new Date().toISOString(),
    }));
    const result = requireKanban(updated, kanbanId);
    this.notifyUpsert(result);
    return result;
  }

  // Stubbed at [] to avoid taking an agent-manager/workspace-registry dependency in this
  // slice; live peer status wiring lands with orchestrator provisioning.
  async listOrchestratorPeers(): Promise<OrchestratorPeer[]> {
    return [];
  }
}
