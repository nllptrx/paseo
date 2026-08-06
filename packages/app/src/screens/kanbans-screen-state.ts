import type { AggregateLoadState, AggregatedKanban } from "@/kanban/aggregated-kanbans";

export type KanbansScreenBodyState =
  | { kind: "loading" }
  | { kind: "load-error" }
  | { kind: "empty" }
  | { kind: "content" };

export function resolveKanbansScreenBodyState(input: {
  loadState: AggregateLoadState<AggregatedKanban>;
  visibleCount: number;
  showLoadError: boolean;
}): KanbansScreenBodyState {
  if (input.showLoadError) {
    return { kind: "load-error" };
  }
  if (input.loadState.status === "connecting" || input.loadState.status === "loading") {
    return { kind: "loading" };
  }
  if (input.visibleCount === 0) {
    return { kind: "empty" };
  }
  return { kind: "content" };
}
