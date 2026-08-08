/**
 * What a tracker project is created with until someone picks something else.
 *
 * A literal rather than a theme token on purpose: this is stored on the project
 * and read back by every client, so it has to mean the same colour on a phone
 * in dark mode as in a light-themed browser. A token would resolve to whichever
 * theme happened to be active on the device that created the board.
 */
export const DEFAULT_TASK_PROJECT_COLOR = "#7C6BF5";
