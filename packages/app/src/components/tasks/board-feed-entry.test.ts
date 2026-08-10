import { describe, expect, it } from "vitest";
import {
  activityFeedEntryCanCollapse,
  activityFeedShowsHeader,
  feedEntryCanCollapse,
  flattenMarkdownForFeed,
  groupActivityFeedEntries,
} from "./board-feed-entry.logic";

describe("feedEntryCanCollapse", () => {
  it("keeps short updates fully visible", () => {
    expect(feedEntryCanCollapse("A short update with the result.")).toBe(false);
  });

  it("collapses long prose updates", () => {
    expect(feedEntryCanCollapse("x".repeat(321))).toBe(true);
  });

  it("collapses updates with more than four explicit lines", () => {
    expect(feedEntryCanCollapse("one\ntwo\nthree\nfour\nfive")).toBe(true);
  });
});

describe("activityFeedEntryCanCollapse", () => {
  it("keeps compact updates fully visible", () => {
    expect(activityFeedEntryCanCollapse("A short task event")).toBe(false);
  });

  it("collapses reports before they dominate the activity timeline", () => {
    expect(activityFeedEntryCanCollapse("x".repeat(181))).toBe(true);
    expect(activityFeedEntryCanCollapse("one\ntwo\nthree\nfour")).toBe(true);
  });
});

describe("groupActivityFeedEntries", () => {
  const systemEvent = (id: string, body: string) => ({
    id,
    body,
    kind: "system" as const,
    entryKind: "system_event",
    createdAt: `2026-08-10T17:0${id}:00.000Z`,
  });

  it("coalesces consecutive identical system events", () => {
    const groups = groupActivityFeedEntries([
      systemEvent("1", "Agent stopped"),
      systemEvent("2", "Agent stopped"),
      systemEvent("3", "Task moved"),
    ]);

    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({
      entry: { id: "2" },
      repeatCount: 2,
      firstCreatedAt: "2026-08-10T17:01:00.000Z",
    });
  });

  it("keeps human and agent-authored entries separate", () => {
    const shared = { body: "Done", createdAt: "2026-08-10T17:00:00.000Z" };
    const groups = groupActivityFeedEntries([
      { ...shared, id: "1", kind: "user" as const, entryKind: "note" },
      { ...shared, id: "2", kind: "user" as const, entryKind: "note" },
      { ...shared, id: "3", kind: "agent" as const, entryKind: "agent_update" },
    ]);

    expect(groups.map((group) => group.repeatCount)).toEqual([1, 1, 1]);
  });
});

describe("flattenMarkdownForFeed", () => {
  it("strips heading markers, inline code, and emphasis", () => {
    expect(flattenMarkdownForFeed("## Review ETC-1 — Project Init\n\nRan `flutter analyze`.")).toBe(
      "Review ETC-1 — Project Init\n\nRan flutter analyze.",
    );
    expect(flattenMarkdownForFeed("**done** and *verified*")).toBe("done and verified");
  });

  it("drops code fence markers but keeps the code", () => {
    expect(flattenMarkdownForFeed("```ts\nconst a = 1;\n```")).toBe("const a = 1;");
  });

  it("reduces links to their text", () => {
    expect(flattenMarkdownForFeed("See [the PR](https://example.com/1)")).toBe("See the PR");
  });

  it("leaves snake_case and arithmetic alone", () => {
    expect(flattenMarkdownForFeed("in_progress stays, 3 * 4 * 5 stays")).toBe(
      "in_progress stays, 3 * 4 * 5 stays",
    );
  });

  it("collapses runs of blank lines", () => {
    expect(flattenMarkdownForFeed("one\n\n\n\ntwo")).toBe("one\n\ntwo");
  });
});

describe("activityFeedShowsHeader", () => {
  const agentUpdate = (authorName: string) => ({
    kind: "agent" as const,
    entryKind: "agent_update" as const,
    authorName,
  });
  const systemEvent = {
    kind: "system" as const,
    entryKind: "system_event" as const,
    authorName: "System",
  };

  it("names the first entry of a run and hides the rest", () => {
    expect(activityFeedShowsHeader(undefined, agentUpdate("Scaffold"))).toBe(true);
    expect(activityFeedShowsHeader(agentUpdate("Scaffold"), agentUpdate("Scaffold"))).toBe(false);
  });

  it("restarts the run on author or kind change", () => {
    expect(activityFeedShowsHeader(agentUpdate("Scaffold"), agentUpdate("Review"))).toBe(true);
    expect(
      activityFeedShowsHeader(agentUpdate("Scaffold"), {
        kind: "user" as const,
        entryKind: "note" as const,
        authorName: "Scaffold",
      }),
    ).toBe(true);
  });

  it("never labels system events and breaks runs around them", () => {
    expect(activityFeedShowsHeader(agentUpdate("Scaffold"), systemEvent)).toBe(false);
    expect(activityFeedShowsHeader(systemEvent, agentUpdate("Scaffold"))).toBe(true);
  });
});
