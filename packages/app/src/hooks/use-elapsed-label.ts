import { useEffect, useState } from "react";
import { subscribeToRelativeTimeTick } from "@/utils/relative-time-ticker";
import { formatDuration } from "@/utils/time";

const MINUTE_MS = 60_000;

function describeElapsed(sinceMs: number, nowMs: number): string {
  const elapsed = Math.max(0, nowMs - sinceMs);
  // Rounded down to the minute so the label never claims a precision the shared
  // minute ticker cannot keep current. A per-second timer for a board full of
  // cards costs more than the seconds are worth.
  if (elapsed < MINUTE_MS) {
    return "<1m";
  }
  return formatDuration(Math.floor(elapsed / MINUTE_MS) * MINUTE_MS);
}

/**
 * A live "how long has this been running" label, empty when nothing is running.
 * Rides the shared minute tier rather than owning a timer, so a board of idle
 * cards runs no timers at all.
 */
export function useElapsedLabel(since: Date | null): string {
  const sinceMs = since === null ? null : since.getTime();
  const [label, setLabel] = useState(() =>
    sinceMs === null ? "" : describeElapsed(sinceMs, Date.now()),
  );

  useEffect(() => {
    if (sinceMs === null) {
      setLabel("");
      return undefined;
    }
    setLabel(describeElapsed(sinceMs, Date.now()));
    return subscribeToRelativeTimeTick("minute", () => {
      setLabel((current) => {
        const next = describeElapsed(sinceMs, Date.now());
        return next === current ? current : next;
      });
    });
  }, [sinceMs]);

  return label;
}
