import type { OutputSchema } from "../../../output/index.js";
import { derivePlanColumn } from "@getpaseo/protocol/kanban/derive";
import type { KanbanPlan, NestedPlan, StepRun } from "@getpaseo/protocol/kanban/types";

export interface PlanRow {
  id: string;
  title: string;
  kind: string;
  column: string;
  archivedAt: string | null;
}

export const planSchema: OutputSchema<PlanRow> = {
  idField: "id",
  columns: [
    { header: "ID", field: "id", width: 10 },
    { header: "TITLE", field: "title", width: 30 },
    { header: "KIND", field: "kind", width: 14 },
    { header: "COLUMN", field: "column", width: 14 },
  ],
};

export function toPlanRow(plan: KanbanPlan | NestedPlan): PlanRow {
  return {
    id: plan.id,
    title: plan.title,
    kind: plan.body.type,
    column: derivePlanColumn(plan),
    archivedAt: plan.archivedAt,
  };
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
    { key: "Column", value: derivePlanColumn(plan) },
  ];
  if (plan.body.type === "workflow") {
    rows.push({
      key: "Steps",
      value: plan.body.steps.map((step) => `${step.id}:${step.name}`).join(", ") || "none",
    });
  } else {
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
