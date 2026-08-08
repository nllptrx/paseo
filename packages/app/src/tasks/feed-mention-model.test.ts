import { describe, expect, it } from "vitest";
import type { Task } from "@getpaseo/protocol/tasks/types";
import {
  applyMention,
  collectMentionCandidates,
  filterMentionCandidates,
  findActiveMention,
} from "./feed-mention-model";

describe("findActiveMention", () => {
  it("finds the mention the caret sits in", () => {
    expect(findActiveMention("ping @agt", 9)).toEqual({ start: 5, term: "agt" });
  });

  it("opens on an @ at the very start", () => {
    expect(findActiveMention("@ag", 3)).toEqual({ start: 0, term: "ag" });
  });

  /** An address inside a word is not a mention, or every email would open the
   * picker halfway through typing it. */
  it("ignores an @ that is not at a word boundary", () => {
    expect(findActiveMention("mail me@example", 15)).toBeNull();
  });

  /** The mention ended at the space; what follows is prose. */
  it("closes once the mention is followed by a space", () => {
    expect(findActiveMention("@agt_1 can you", 14)).toBeNull();
  });
});

function taskWith(id: string, title: string, agentIds: string[]): Task {
  return {
    id,
    projectId: "p1",
    number: 1,
    title,
    description: "",
    status: "in_progress",
    priority: "none",
    dueDate: null,
    parentTaskId: null,
    position: 1024,
    labelIds: [],
    agents: agentIds.map((agentId) => ({
      agentId,
      workspaceId: "ws",
      presetId: null,
      attachedAt: "2026-01-01T00:00:00.000Z",
    })),
    attachments: [],
    commentCount: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("collectMentionCandidates", () => {
  /** An agent on two cards is one person to mention, listed once. */
  it("lists each agent once, with the card it is working", () => {
    const candidates = collectMentionCandidates({
      tasks: [taskWith("t1", "First", ["agt_1"]), taskWith("t2", "Second", ["agt_1", "agt_2"])],
      taskKeyById: new Map([
        ["t1", "PSE-1"],
        ["t2", "PSE-2"],
      ]),
    });
    expect(candidates).toEqual([
      { agentId: "everyone", taskKey: "", taskTitle: "" },
      { agentId: "agt_1", taskKey: "PSE-1", taskTitle: "First" },
      // Second card holds two agents, so its rows say which one they are.
      { agentId: "agt_2", taskKey: "PSE-2", taskTitle: "Second", position: 2, of: 2 },
    ]);
  });

  /** The board-wide target is the daemon's, not a card's — offering it with no
   * agents to reach would be a mention that can only fail. */
  it("offers nothing at all when no agent is attached", () => {
    expect(
      collectMentionCandidates({ tasks: [taskWith("t1", "First", [])], taskKeyById: new Map() }),
    ).toEqual([]);
  });
});

describe("filterMentionCandidates", () => {
  const candidates = [
    { agentId: "agt_1", taskKey: "PSE-1", taskTitle: "Ship the migration" },
    { agentId: "agt_2", taskKey: "PSE-2", taskTitle: "Fix the feed" },
  ];

  it("matches on the card as well as the agent", () => {
    expect(filterMentionCandidates(candidates, "feed").map((c) => c.agentId)).toEqual(["agt_2"]);
    expect(filterMentionCandidates(candidates, "PSE-1").map((c) => c.agentId)).toEqual(["agt_1"]);
  });

  it("offers everyone before anything is typed", () => {
    expect(filterMentionCandidates(candidates, "")).toHaveLength(2);
  });
});

describe("applyMention", () => {
  it("replaces what was typed and reuses the space already after it", () => {
    expect(
      applyMention({ body: "ping @ag rest", mention: { start: 5, term: "ag" }, agentId: "agt_1" }),
    ).toEqual({ body: "ping @agt_1 rest", caret: 12 });
  });

  it("adds the separator when the mention ends the note", () => {
    expect(
      applyMention({ body: "ping @ag", mention: { start: 5, term: "ag" }, agentId: "agt_1" }),
    ).toEqual({ body: "ping @agt_1 ", caret: 12 });
  });
});
