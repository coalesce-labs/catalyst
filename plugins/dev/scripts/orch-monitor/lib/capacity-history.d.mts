// Type declarations for capacity-history.mjs (CTL-1092 Phase 5 capacity-over-time).

/** The event.name the capacity timeline reads from the unified event log. */
export const CAPACITY_CHANGED_EVENT: string;

/** One capacity change step: a maxParallel transition with its reason + timestamp. */
export interface CapacityHistoryStep {
  /** ISO-8601 timestamp of the change. */
  ts: string;
  /** maxParallel before the change. */
  old: number;
  /** maxParallel after the change. */
  new: number;
  /** Human-readable reason from the event payload ("" when absent). */
  reason: string;
}

/**
 * readCapacityHistory — scan the event log for node.capacity.changed events and
 * return a per-host map of time-ordered capacity steps (ascending by ts).
 * Aliased (pre-pin) hostnames merge onto their pinned roster names. Read failures
 * degrade to {}.
 */
export function readCapacityHistory(opts?: {
  /** Injectable reader returning the raw log content; defaults to readFileSync(logPath). */
  read?: () => string;
  /** Event-log path used when `read` is absent. */
  logPath?: string;
  /** Static alias map (pre-pin → pinned host name); absent/null → no aliasing. */
  aliases?: Record<string, string> | null;
}): Record<string, CapacityHistoryStep[]>;
