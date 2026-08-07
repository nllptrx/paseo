import type { Task, TaskProject } from "@getpaseo/protocol/tasks/types";

/**
 * How many agents `@everyone` may wake at once. A board with thirty cards in
 * flight is a board where "tell everybody" is almost never what was meant, and
 * a prompt sent to thirty agents cannot be taken back.
 */
export const FEED_MENTION_FANOUT_LIMIT = 10;

const MENTION_PATTERN = /@([A-Za-z0-9_-]+)/g;

export function parseFeedMentions(body: string): string[] {
  const found = new Set<string>();
  for (const match of body.matchAll(MENTION_PATTERN)) {
    found.add(match[1]);
  }
  return [...found];
}

export interface ResolveFeedMentionsInput {
  body: string;
  /** Every agent attached to a card on this board. */
  boardAgentIds: readonly string[];
  limit?: number;
}

export type ResolveFeedMentionsResult =
  | { ok: true; agentIds: string[] }
  | { ok: false; error: string };

/**
 * Who a note in the feed wakes.
 *
 * Targets are drawn from the agents attached to this board's cards and nowhere
 * else: a board is not a directory of every agent on the host, and letting a
 * note reach one that has nothing to do with this work would make the feed a
 * way to page strangers.
 *
 * A mention that matches nobody is not an error — it is a person typing an
 * email address into a sentence, and the note still posts.
 */
export function resolveFeedMentions(input: ResolveFeedMentionsInput): ResolveFeedMentionsResult {
  const mentioned = parseFeedMentions(input.body);
  if (mentioned.length === 0) {
    return { ok: true, agentIds: [] };
  }

  const onBoard = new Set(input.boardAgentIds);
  if (mentioned.includes("everyone")) {
    const everyone = [...onBoard];
    const limit = input.limit ?? FEED_MENTION_FANOUT_LIMIT;
    if (everyone.length > limit) {
      return {
        ok: false,
        error: `@everyone would notify ${everyone.length} agents on this board, over the limit of ${limit}. Mention the ones you mean.`,
      };
    }
    return { ok: true, agentIds: everyone };
  }

  return { ok: true, agentIds: mentioned.filter((agentId) => onBoard.has(agentId)) };
}

export interface FeedMentionNotificationInput {
  project: Pick<TaskProject, "name" | "prefix">;
  task: Pick<Task, "number" | "title"> | null;
  body: string;
}

/** What a mentioned agent is told: where it was said, about what, and the note. */
export function formatFeedMentionNotification(input: FeedMentionNotificationInput): string {
  const where = input.task
    ? `${input.project.prefix}-${input.task.number} "${input.task.title}"`
    : `the ${input.project.name} board`;
  return [
    `You were mentioned on ${where}.`,
    "",
    input.body,
    "",
    "Reply by commenting on the task so the board keeps the answer.",
  ].join("\n");
}
