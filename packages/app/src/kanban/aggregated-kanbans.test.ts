import { QueryClient } from "@tanstack/react-query";
import type { KanbanSummary } from "@getpaseo/protocol/kanban/types";
import { describe, expect, it } from "vitest";
import type {
  AggregatedKanban,
  FetchAggregatedKanbansResult,
  FetchAggregatedKanbansState,
} from "./aggregated-kanbans";
import { kanbansQueryBaseKey, updateAggregatedKanbansData } from "./aggregated-kanbans";

function kanban(overrides: Partial<AggregatedKanban> = {}): AggregatedKanban {
  const base: KanbanSummary = {
    id: "kanban-1",
    projectId: "project-1",
    name: "Board",
    autoAdvance: false,
    orchestrator: null,
    columns: [],
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    archivedAt: null,
  };
  return { ...base, serverId: "host-a", serverName: "Host A", ...overrides };
}

function archiveKanbans(kanbans: AggregatedKanban[]): AggregatedKanban[] {
  return kanbans.map((entry) => ({ ...entry, archivedAt: "2026-07-02T00:00:00.000Z" }));
}

function archiveAggregatedKanbans(
  current: FetchAggregatedKanbansState | undefined,
): FetchAggregatedKanbansState | undefined {
  return updateAggregatedKanbansData(current, archiveKanbans);
}

describe("updateAggregatedKanbansData", () => {
  it("updates the canonical loaded data field", () => {
    const current: FetchAggregatedKanbansResult = {
      status: "loaded",
      data: [kanban()],
      hostErrors: [],
    };

    const result = updateAggregatedKanbansData(current, archiveKanbans);

    expect(result).toEqual({
      status: "loaded",
      data: [kanban({ archivedAt: "2026-07-02T00:00:00.000Z" })],
      hostErrors: [],
    });
  });

  it("leaves an empty cache entry empty", () => {
    const result = updateAggregatedKanbansData(undefined, () => [kanban()]);

    expect(result).toBeUndefined();
  });

  it("leaves connecting cache entries untouched while updating loaded entries", () => {
    const queryClient = new QueryClient();
    const connectingKey = [...kanbansQueryBaseKey, "connecting"];
    const loadedKey = [...kanbansQueryBaseKey, "loaded"];
    const connecting = { status: "connecting" } as const;
    const loaded: FetchAggregatedKanbansResult = {
      status: "loaded",
      data: [kanban()],
      hostErrors: [],
    };
    queryClient.setQueryData(connectingKey, connecting);
    queryClient.setQueryData(loadedKey, loaded);

    expect(() => {
      queryClient.setQueriesData<FetchAggregatedKanbansState>(
        { queryKey: kanbansQueryBaseKey },
        archiveAggregatedKanbans,
      );
    }).not.toThrow();

    expect(queryClient.getQueryData(connectingKey)).toEqual(connecting);
    expect(queryClient.getQueryData(loadedKey)).toEqual({
      status: "loaded",
      data: [kanban({ archivedAt: "2026-07-02T00:00:00.000Z" })],
      hostErrors: [],
    });
  });
});
