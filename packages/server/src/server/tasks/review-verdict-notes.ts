/**
 * The wording a review verdict leaves in the board feed, owned in one place.
 *
 * The feed is the only record of how a subtask was judged, and the aggregate's
 * final review reads its children's verdicts back out of it. Writer and reader
 * therefore share these phrases: with the wording inlined at both ends, editing
 * a feed sentence silently emptied the verdict list the final reviewer is given.
 */
export const REVIEW_APPROVED_NOTE = "was approved";

export const REVIEW_REJECTED_NOTE = "was rejected";

/** Whether a feed entry's body records a review verdict. */
export function isReviewVerdictNote(body: string): boolean {
  return body.includes(REVIEW_APPROVED_NOTE) || body.includes(REVIEW_REJECTED_NOTE);
}
