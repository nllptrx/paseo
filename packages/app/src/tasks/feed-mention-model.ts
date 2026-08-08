import type { Task } from "@getpaseo/protocol/tasks/types";

export interface FeedMentionCandidate {
  agentId: string;
  /** The card the agent is working, so two agents on one board are told apart
   * by what they are doing rather than by a hex id. */
  taskKey: string;
  taskTitle: string;
  /** Which of the card's agents this is, when the card has more than one. Two
   * agents on one card are otherwise the same row twice. */
  position?: number;
  of?: number;
}

export interface FeedMentionQuery {
  /** Where the `@` that opened the picker sits. */
  start: number;
  /** What has been typed after it. */
  term: string;
}

/**
 * The mention being typed, if the caret is inside one. A mention runs from an
 * `@` to the first space, so a note that merely contains an address does not
 * reopen the picker halfway through a word.
 */
export function findActiveMention(body: string, caret: number): FeedMentionQuery | null {
  const before = body.slice(0, caret);
  const at = before.lastIndexOf("@");
  if (at === -1) {
    return null;
  }
  if (at > 0 && !/\s/.test(before[at - 1])) {
    return null;
  }
  const term = before.slice(at + 1);
  if (/\s/.test(term)) {
    return null;
  }
  return { start: at, term };
}

/**
 * Every agent attached to a card on this board, newest card first, plus the
 * board-wide target the daemon already understands.
 *
 * Two agents on one card would otherwise be two identical rows — the card is
 * what a person recognises, but it is not what a mention addresses — so each
 * row also carries which of the card's agents it is.
 */
export function collectMentionCandidates(input: {
  tasks: readonly Task[];
  taskKeyById: ReadonlyMap<string, string>;
}): FeedMentionCandidate[] {
  const seen = new Set<string>();
  const candidates: FeedMentionCandidate[] = [];
  for (const task of input.tasks) {
    task.agents.forEach((link, index) => {
      if (seen.has(link.agentId)) {
        return;
      }
      seen.add(link.agentId);
      candidates.push({
        agentId: link.agentId,
        taskKey: input.taskKeyById.get(task.id) ?? "",
        taskTitle: task.title,
        ...(task.agents.length > 1 ? { position: index + 1, of: task.agents.length } : {}),
      });
    });
  }
  if (candidates.length > 0) {
    candidates.unshift({ agentId: EVERYONE_MENTION, taskKey: "", taskTitle: "" });
  }
  return candidates;
}

/** The daemon resolves this to every agent on the board, and refuses when that
 * would wake more than it allows. */
export const EVERYONE_MENTION = "everyone";

export function filterMentionCandidates(
  candidates: readonly FeedMentionCandidate[],
  term: string,
): FeedMentionCandidate[] {
  const needle = term.trim().toLowerCase();
  if (needle.length === 0) {
    return [...candidates];
  }
  return candidates.filter(
    (candidate) =>
      candidate.agentId.toLowerCase().includes(needle) ||
      candidate.taskKey.toLowerCase().includes(needle) ||
      candidate.taskTitle.toLowerCase().includes(needle),
  );
}

/** Replaces the mention being typed with the chosen agent, and leaves a space
 * so the next word is not swallowed into it. */
export function applyMention(input: { body: string; mention: FeedMentionQuery; agentId: string }): {
  body: string;
  caret: number;
} {
  const head = input.body.slice(0, input.mention.start);
  const tail = input.body.slice(input.mention.start + 1 + input.mention.term.length);
  // Picking a name mid-sentence must not push a second space into it: the
  // separator that is already there is the one the writer typed. Either way the
  // caret lands past the separator, ready for the next word.
  const reusesSeparator = tail.startsWith(" ");
  const inserted = reusesSeparator ? `@${input.agentId}` : `@${input.agentId} `;
  const caret = head.length + inserted.length + (reusesSeparator ? 1 : 0);
  return { body: `${head}${inserted}${tail}`, caret };
}
