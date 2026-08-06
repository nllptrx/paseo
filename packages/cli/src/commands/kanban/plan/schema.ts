import type { OutputSchema } from "../../../output/index.js";
import type {
  Column,
  KanbanPlan,
  NestedPlan,
  StepRun,
  StoredKanban,
} from "@getpaseo/protocol/kanban/types";

export interface PlanRow {
  id: string;
  title: string;
  kind: string;
  columnId: string | null;
  archivedAt: string | null;
}

export const planSchema: OutputSchema<PlanRow> = {
  idField: "id",
  columns: [
    { header: "ID", field: "id", width: 10 },
    { header: "TITLE", field: "title", width: 30 },
    { header: "KIND", field: "kind", width: 14 },
    { header: "COLUMN", field: "columnId", width: 14 },
  ],
};

export function toPlanRow(columns: Column[], plan: KanbanPlan | NestedPlan): PlanRow {
  const column = columns.find((candidate) => candidate.planIds.includes(plan.id));
  return {
    id: plan.id,
    title: plan.title,
    kind: plan.body.type,
    columnId: column?.id ?? null,
    archivedAt: plan.archivedAt,
  };
}

export function columnsFor(
  kanban: StoredKanban,
  parentPlanId: string | null | undefined,
): Column[] {
  if (!parentPlanId) {
    return kanban.columns;
  }
  const parent = kanban.plans[parentPlanId];
  if (!parent || parent.body.type !== "nested_kanban") {
    throw new Error(`Nested kanban plan not found: ${parentPlanId}`);
  }
  return parent.body.columns;
}

export interface PlanInspectRow {
  key: string;
  value: string;
}

export function createPlanInspectSchema(
  plan: KanbanPlan | NestedPlan,
): OutputSchema<PlanInspectRow> {
  return {
    idField: "key",
    columns: [
      { header: "KEY", field: "key", width: 18 },
      { header: "VALUE", field: "value", width: 80 },
    ],
    serialize: () => plan,
  };
}

export function createPlanInspectRows(plan: KanbanPlan | NestedPlan): PlanInspectRow[] {
  const rows: PlanInspectRow[] = [
    { key: "Id", value: plan.id },
    { key: "Title", value: plan.title },
    { key: "Description", value: plan.description ?? "null" },
    { key: "Kind", value: plan.body.type },
    { key: "CreatedAt", value: plan.createdAt },
    { key: "UpdatedAt", value: plan.updatedAt },
    { key: "ArchivedAt", value: plan.archivedAt ?? "null" },
    {
      key: "LastMove",
      value: plan.lastMove ? `${plan.lastMove.by} at ${plan.lastMove.at}` : "null",
    },
  ];
  if (plan.body.type === "workflow") {
    rows.push({
      key: "Steps",
      value: plan.body.steps.map((step) => `${step.id}:${step.name}`).join(", ") || "none",
    });
  } else {
    rows.push({ key: "Columns", value: `${plan.body.columns.length}` });
    rows.push({ key: "NestedPlans", value: `${Object.keys(plan.body.plans).length}` });
  }
  return rows;
}

export interface PlanLogRow {
  stepId: string;
  stepName: string;
  runId: string;
  status: string;
  startedAt: string;
  endedAt: string | null;
  error: string | null;
}

export const planLogSchema: OutputSchema<PlanLogRow> = {
  idField: "runId",
  columns: [
    { header: "STEP", field: "stepName", width: 18 },
    { header: "RUN ID", field: "runId", width: 14 },
    { header: "STATUS", field: "status", width: 12 },
    { header: "STARTED", field: "startedAt", width: 24 },
    { header: "ENDED", field: "endedAt", width: 24 },
    { header: "ERROR", field: "error", width: 30 },
  ],
};

export function toPlanLogRows(
  plan: KanbanPlan | NestedPlan,
  stepIdFilter: string | undefined,
): PlanLogRow[] {
  if (plan.body.type !== "workflow") {
    return [];
  }
  return plan.body.steps
    .filter((step) => !stepIdFilter || step.id === stepIdFilter)
    .flatMap((step) =>
      step.runs.map((run: StepRun) => ({
        stepId: step.id,
        stepName: step.name,
        runId: run.id,
        status: run.status,
        startedAt: run.startedAt,
        endedAt: run.endedAt,
        error: run.error,
      })),
    );
}
