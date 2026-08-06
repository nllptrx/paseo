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
import type { AgentManager } from "../agent/agent-manager.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import { KanbanStore } from "./store.js";

type ColumnInput = Omit<Column, "id" | "planIds">;
type StepInput = Omit<Step, "id" | "runs">;

type KanbanPlanCreateBody =
  | { type: "workflow"; steps: StepInput[] }
  | { type: "nested_kanban"; columns?: ColumnInput[] };

export interface KanbanServiceOptions {
  store: KanbanStore;
  logger: pino.Logger;
  // Optional: only needed to resolve live status/attention for orchestrator peer
  // listing. Kept optional so callers that never touch the orchestrator mesh (most
  // unit tests) don't have to construct an AgentManager/AgentStorage.
  agentManager?: Pick<AgentManager, "getAgent">;
  agentStorage?: Pick<AgentStorage, "get">;
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
  private readonly agentManager?: Pick<AgentManager, "getAgent">;
  private readonly agentStorage?: Pick<AgentStorage, "get">;

  constructor(options: KanbanServiceOptions) {
    this.store = options.store;
    this.logger = options.logger.child({ module: "kanban-service" });
    this.agentManager = options.agentManager;
    this.agentStorage = options.agentStorage;
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
    // Archiving a kanban is what removes it from every board surface; the record
    // stays on disk so an archived kanban can still be read by id.
    return kanbans.filter((kanban) => !kanban.archivedAt).map(toKanbanSummary);
  }

  async get(id: string): Promise<StoredKanban | null> {
    return this.store.get(id);
  }

  // Read-only plan lookup shared by callers that only need one plan (MCP plan_logs,
  // move_plan authorization) without duplicating the top-level/nested resolution.
  async getPlan(
    kanbanId: string,
    planId: string,
    parentPlanId?: string | null,
  ): Promise<KanbanPlan> {
    const kanban = requireKanban(await this.store.get(kanbanId), kanbanId);
    return parentPlanId
      ? findNestedPlan(kanban, parentPlanId, planId)
      : findTopLevelPlan(kanban, planId);
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
      // Lifecycle sync is the visible payoff of the overlay by default; explicit
      // user/agent moves still win via the move-precedence rule.
      autoAdvance: true,
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
    // "sync" is engine-internal (lifecycle sync automations) — the wire schema
    // only ever carries "user" | "agent"; never accept "sync" from a request.
    movedBy: "user" | "agent" | "sync";
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

  // Joins every non-archived kanban's orchestrator pointer against live agent state
  // (falling back to the persisted record when the agent isn't currently loaded) —
  // no peer status is stored on the kanban itself.
  async listOrchestratorPeers(): Promise<OrchestratorPeer[]> {
    const kanbans = await this.store.list();
    const peers: OrchestratorPeer[] = [];
    for (const kanban of kanbans) {
      if (kanban.archivedAt || !kanban.orchestrator) {
        continue;
      }
      const { workspaceId, agentId } = kanban.orchestrator;
      const status = await this.resolveOrchestratorAgentStatus(agentId);
      peers.push({
        kanbanId: kanban.id,
        kanbanName: kanban.name,
        projectId: kanban.projectId,
        workspaceId,
        agentId,
        agentLastStatus: status.lastStatus,
        attention: status.attention,
      });
    }
    return peers;
  }

  private async resolveOrchestratorAgentStatus(
    agentId: string,
  ): Promise<{ lastStatus: string | null; attention: boolean }> {
    const live = this.agentManager?.getAgent(agentId) ?? null;
    if (live) {
      return { lastStatus: live.lifecycle, attention: live.attention.requiresAttention };
    }
    const stored = (await this.agentStorage?.get(agentId)) ?? null;
    return {
      lastStatus: stored?.lastStatus ?? null,
      attention: Boolean(stored?.attentionReason),
    };
  }

  // Read-only lookup of a plan (top-level or nested) — used by the workflow engine
  // for gate checks and column-automation decisions without taking a write lock.
  async getPlan(input: {
    kanbanId: string;
    parentPlanId?: string | null;
    planId: string;
  }): Promise<{ kanban: StoredKanban; plan: KanbanPlan }> {
    const kanban = requireKanban(await this.store.get(input.kanbanId), input.kanbanId);
    const plan = input.parentPlanId
      ? findNestedPlan(kanban, input.parentPlanId, input.planId)
      : findTopLevelPlan(kanban, input.planId);
    return { kanban, plan };
  }

  // The single write-path for step mutations (new runs, retries, skips, cancels):
  // locates the step inside its plan (top-level or nested), replaces it via
  // `mutate`, and persists. `mutate` receives the step's siblings so callers can
  // make gate decisions (e.g. "is the previous step done?") atomically with the
  // write instead of re-reading afterwards.
  async mutateStep(input: {
    kanbanId: string;
    parentPlanId?: string | null;
    planId: string;
    stepId: string;
    mutate: (step: Step, context: { steps: Step[]; stepIndex: number }) => Step;
  }): Promise<{ kanban: StoredKanban; plan: KanbanPlan; step: Step }> {
    const now = new Date().toISOString();
    let resultStep: Step | undefined;
    let resultPlan: KanbanPlan | undefined;

    const updated = await this.store.update(input.kanbanId, (kanban) => {
      requireActiveKanban(kanban, input.kanbanId);

      if (!input.parentPlanId) {
        const plan = findTopLevelPlan(kanban, input.planId);
        if (plan.body.type !== "workflow") {
          throw new Error(`Plan is not a workflow: ${input.planId}`);
        }
        const { steps, step, index } = replaceStep(plan.body.steps, input.stepId, input.mutate);
        const nextPlan: KanbanPlan = { ...plan, updatedAt: now, body: { ...plan.body, steps } };
        resultStep = step;
        resultPlan = nextPlan;
        void index;
        return {
          ...kanban,
          plans: { ...kanban.plans, [input.planId]: nextPlan },
          updatedAt: now,
        };
      }

      const parent = findNestedParentPlan(kanban, input.parentPlanId);
      if (parent.body.type !== "nested_kanban") {
        throw new Error(`Plan is not a nested kanban: ${input.parentPlanId}`);
      }
      const nested = findNestedPlan(kanban, input.parentPlanId, input.planId);
      const { steps, step } = replaceStep(nested.body.steps, input.stepId, input.mutate);
      const nextNested: NestedPlan = { ...nested, updatedAt: now, body: { ...nested.body, steps } };
      resultStep = step;
      resultPlan = nextNested;
      const updatedParent: KanbanPlan = {
        ...parent,
        updatedAt: now,
        body: { ...parent.body, plans: { ...parent.body.plans, [input.planId]: nextNested } },
      };
      return {
        ...kanban,
        plans: { ...kanban.plans, [input.parentPlanId]: updatedParent },
        updatedAt: now,
      };
    });

    const result = requireKanban(updated, input.kanbanId);
    this.notifyUpsert(result);
    if (!resultStep || !resultPlan) {
      throw new Error("Step mutation failed unexpectedly");
    }
    return { kanban: result, plan: resultPlan, step: resultStep };
  }
}

function replaceStep(
  steps: Step[],
  stepId: string,
  mutate: (step: Step, context: { steps: Step[]; stepIndex: number }) => Step,
): { steps: Step[]; step: Step; index: number } {
  const index = steps.findIndex((step) => step.id === stepId);
  if (index === -1) {
    throw new Error(`Step not found: ${stepId}`);
  }
  const nextStep = mutate(steps[index], { steps, stepIndex: index });
  const nextSteps = steps.map((step, i) => (i === index ? nextStep : step));
  return { steps: nextSteps, step: nextStep, index };
}
