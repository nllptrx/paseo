import { describe, expect, it } from "vitest";
import {
  FEED_MENTION_FANOUT_LIMIT,
  formatFeedMentionNotification,
  parseFeedMentions,
  resolveFeedMentions,
} from "./feed-mentions.js";

describe("parseFeedMentions", () => {
  it("takes each name once", () => {
    expect(parseFeedMentions("@agt_1 and @agt_1 and @agt_2")).toEqual(["agt_1", "agt_2"]);
  });

  it("finds nothing in a note with no mention", () => {
    expect(parseFeedMentions("shipped the migration")).toEqual([]);
  });
});

describe("resolveFeedMentions", () => {
  const boardAgentIds = ["agt_1", "agt_2"];

  /** A board is not a directory of the host. Paging an agent that has nothing
   * to do with this work is not something a note here should be able to do. */
  it("only reaches agents attached to this board", () => {
    const result = resolveFeedMentions({
      body: "@agt_1 @agt_elsewhere please look",
      boardAgentIds,
    });
    expect(result).toEqual({ ok: true, agentIds: ["agt_1"] });
  });

  /** An address in a sentence reads as a mention of its domain. Nobody on the
   * board answers to that, so the note posts and wakes no one. */
  it("wakes nobody for an email-shaped address", () => {
    const result = resolveFeedMentions({
      body: "ask ferrari@mastersoft.it about the migration",
      boardAgentIds,
    });
    expect(result).toEqual({ ok: true, agentIds: [] });
  });

  /** Typing an address into a sentence is not an error, and the note still
   * has to post. */
  it("treats a mention that matches nobody as no mention", () => {
    const result = resolveFeedMentions({ body: "ping @nobody", boardAgentIds });
    expect(result).toEqual({ ok: true, agentIds: [] });
  });

  it("expands everyone to the board's agents", () => {
    const result = resolveFeedMentions({ body: "@everyone standup", boardAgentIds });
    expect(result).toEqual({ ok: true, agentIds: boardAgentIds });
  });

  it("refuses an everyone that would wake more agents than the limit", () => {
    const many = Array.from({ length: FEED_MENTION_FANOUT_LIMIT + 1 }, (_, i) => `agt_${i}`);
    const result = resolveFeedMentions({ body: "@everyone", boardAgentIds: many });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/over the limit/);
  });
});

describe("formatFeedMentionNotification", () => {
  it("names the card when there is one", () => {
    const text = formatFeedMentionNotification({
      project: { name: "Paseo", prefix: "PSE" },
      task: { number: 42, title: "Ship it" },
      body: "@agt_1 can you take this",
    });
    expect(text).toContain('PSE-42 "Ship it"');
  });

  it("names the board when the note is not about a card", () => {
    const text = formatFeedMentionNotification({
      project: { name: "Paseo", prefix: "PSE" },
      task: null,
      body: "@everyone standup",
    });
    expect(text).toContain("the Paseo board");
  });
});
