import { describe, expect, it } from "vitest";
import {
  KanbanListRequestSchema,
  KanbanListResponseSchema,
  KanbanPlanCreateRequestSchema,
  KanbanUpdatePushSchema,
} from "./rpc-schemas.js";

describe("kanban RPC schemas", () => {
  it("round-trips kanban.list.request/.response", () => {
    const request = { type: "kanban.list.request" as const, requestId: "req-1" };
    expect(KanbanListRequestSchema.parse(request)).toEqual(request);

    const response = {
      type: "kanban.list.response" as const,
      payload: { requestId: "req-1", kanbans: [], error: null },
    };
    expect(KanbanListResponseSchema.parse(response)).toEqual(response);
  });

  it("round-trips kanban.plan.create.request with a workflow body", () => {
    const request = {
      type: "kanban.plan.create.request" as const,
      requestId: "req-2",
      kanbanId: "kbn_1",
      title: "Ship it",
      body: {
        type: "workflow" as const,
        steps: [
          {
            name: "Build",
            prompt: "Run the build",
            agents: [{ provider: "claude" }],
            completion: "all" as const,
            workspace: { mode: "worktree" as const },
            trigger: { type: "immediate" as const },
          },
        ],
      },
    };

    expect(KanbanPlanCreateRequestSchema.parse(request)).toEqual(request);
  });

  it("round-trips the kanban.update push event", () => {
    const removeEvent = {
      type: "kanban.update" as const,
      payload: { kind: "remove" as const, kanbanId: "kbn_1" },
    };

    expect(KanbanUpdatePushSchema.parse(removeEvent)).toEqual(removeEvent);
  });
});
