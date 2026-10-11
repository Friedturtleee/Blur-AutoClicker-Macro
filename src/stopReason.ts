type StopReasonLabel = {
  full: string;
  compact?: string;
};

const STOP_REASON_LABELS: Record<string, StopReasonLabel> = {
  "Stopped from UI": { full: "Stopped from UI", compact: "Stopped" },
  "Stopped from toggle": { full: "Stopped from toggle", compact: "Stopped" },
  "Stopped from hotkey": { full: "Stopped from hotkey", compact: "Stopped" },
  "Stopped from hold hotkey": {
    full: "Stopped from hold hotkey",
    compact: "Stopped",
  },
  Stopped: { full: "Stopped" },
  "Top-left corner failsafe": {
    full: "Top-left corner failsafe",
    compact: "Corner failsafe",
  },
  "Top-right corner failsafe": {
    full: "Top-right corner failsafe",
    compact: "Corner failsafe",
  },
  "Bottom-left corner failsafe": {
    full: "Bottom-left corner failsafe",
    compact: "Corner failsafe",
  },
  "Bottom-right corner failsafe": {
    full: "Bottom-right corner failsafe",
    compact: "Corner failsafe",
  },
  "Top edge failsafe": { full: "Top edge failsafe", compact: "Edge failsafe" },
  "Right edge failsafe": {
    full: "Right edge failsafe",
    compact: "Edge failsafe",
  },
  "Bottom edge failsafe": {
    full: "Bottom edge failsafe",
    compact: "Edge failsafe",
  },
  "Left edge failsafe": {
    full: "Left edge failsafe",
    compact: "Edge failsafe",
  },
  "Blocked by Alt+Tab": { full: "Blocked by Alt+Tab" },
  "Blocked by process list": { full: "Blocked by process list" },
};

export function formatStopReason(
  stopReason: string | null | undefined,
  compact = false,
): string {
  if (!stopReason) return "";

  const knownReason = Object.prototype.hasOwnProperty.call(
    STOP_REASON_LABELS,
    stopReason,
  )
    ? STOP_REASON_LABELS[stopReason]
    : undefined;
  if (knownReason) {
    return (compact ? knownReason.compact : undefined) ?? knownReason.full;
  }

  const clickLimit = stopReason.match(/^Click limit reached \((.+)\)$/);
  if (clickLimit) {
    return compact
      ? "Click limit reached"
      : `Click limit reached (${clickLimit[1]})`;
  }

  const timeLimit = stopReason.match(/^Time limit reached \((.+)\)$/);
  if (timeLimit) {
    return compact
      ? "Time limit reached"
      : `Time limit reached (${timeLimit[1]})`;
  }

  return stopReason;
}
