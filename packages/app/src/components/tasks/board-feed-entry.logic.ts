import type { TaskComment } from "@getpaseo/protocol/tasks/types";

export const COLLAPSED_FEED_BODY_LINES = 4;

export type FeedEntryKind = NonNullable<TaskComment["entryKind"]>;

export function resolveFeedEntryKind(
  entry: Pick<TaskComment, "kind" | "entryKind">,
): FeedEntryKind {
  if (entry.entryKind) return entry.entryKind;
  if (entry.kind === "agent") return "agent_update";
  if (entry.kind === "system") return "system_event";
  return "note";
}

/**
 * A run of consecutive updates from one author reads as one block: the header
 * names the run, the entries after it carry only their time. System events
 * never take a header and always break a run.
 */
export function activityFeedShowsHeader(
  previous: Pick<TaskComment, "kind" | "entryKind" | "authorName"> | undefined,
  current: Pick<TaskComment, "kind" | "entryKind" | "authorName">,
): boolean {
  const kind = resolveFeedEntryKind(current);
  if (kind === "system_event") return false;
  if (previous === undefined) return true;
  const previousKind = resolveFeedEntryKind(previous);
  if (previousKind === "system_event") return true;
  return previous.authorName !== current.authorName || previousKind !== kind;
}

/**
 * The activity feed is a log, not a document. Agent updates arrive as markdown,
 * and literal `##`/backtick syntax rendered as plain text is noise — flattening
 * keeps the prose while preserving line structure, so numberOfLines collapse
 * still works. Single-underscore emphasis is left alone: snake_case identifiers
 * are more common in agent reports than `_italics_`.
 */
export function flattenMarkdownForFeed(body: string): string {
  return body
    .replace(/^```.*$/gm, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^>\s?/gm, "")
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/__([^_\n]+)__/g, "$1")
    .replace(/\*(\S(?:[^*\n]*\S)?)\*/g, "$1")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/\[([^\]\n]+)\]\([^)\s]+\)/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const COLLAPSED_BODY_CHARACTER_THRESHOLD = 320;
const COLLAPSED_ACTIVITY_CHARACTER_THRESHOLD = 180;
const COLLAPSED_ACTIVITY_LINES = 3;

export function feedEntryCanCollapse(body: string): boolean {
  return (
    body.length > COLLAPSED_BODY_CHARACTER_THRESHOLD ||
    body.split("\n").length > COLLAPSED_FEED_BODY_LINES
  );
}

export function activityFeedEntryCanCollapse(body: string): boolean {
  return (
    body.length > COLLAPSED_ACTIVITY_CHARACTER_THRESHOLD ||
    body.split("\n").length > COLLAPSED_ACTIVITY_LINES
  );
}

export interface ActivityFeedGroup<T> {
  entry: T;
  repeatCount: number;
  firstCreatedAt: string;
}

/** Consecutive identical machine events are one occurrence with a count. Notes,
 * messages and agent-authored updates are never coalesced. */
export function groupActivityFeedEntries<
  T extends {
    body: string;
    kind: "user" | "agent" | "system";
    entryKind?: string;
    createdAt: string;
  },
>(entries: readonly T[]): ActivityFeedGroup<T>[] {
  const groups: ActivityFeedGroup<T>[] = [];
  for (const entry of entries) {
    const previous = groups.at(-1);
    const isSystem =
      entry.entryKind === "system_event" || (!entry.entryKind && entry.kind === "system");
    const canJoin =
      isSystem &&
      previous !== undefined &&
      previous.entry.body === entry.body &&
      (previous.entry.entryKind === "system_event" ||
        (!previous.entry.entryKind && previous.entry.kind === "system"));
    if (canJoin) {
      previous.entry = entry;
      previous.repeatCount += 1;
      continue;
    }
    groups.push({ entry, repeatCount: 1, firstCreatedAt: entry.createdAt });
  }
  return groups;
}
