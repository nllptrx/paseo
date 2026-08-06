// Agent-label convention for the kanban orchestrator mesh, following the
// `paseo.schedule-id` precedent (schedule/service.ts): a plain string key on
// the agent's labels map, no new agent-schema field.
export const KANBAN_ORCHESTRATOR_LABEL = "paseo.kanban-orchestrator";
export const KANBAN_ID_LABEL = "paseo.kanban-id";
export const PLAN_ID_LABEL = "paseo.plan-id";

export function isKanbanOrchestratorAgent(
  labels: Record<string, string> | null | undefined,
): boolean {
  return labels?.[KANBAN_ORCHESTRATOR_LABEL] === "true";
}

export function getKanbanIdFromLabels(
  labels: Record<string, string> | null | undefined,
): string | null {
  const value = labels?.[KANBAN_ID_LABEL];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function getPlanIdFromLabels(
  labels: Record<string, string> | null | undefined,
): string | null {
  const value = labels?.[PLAN_ID_LABEL];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}
