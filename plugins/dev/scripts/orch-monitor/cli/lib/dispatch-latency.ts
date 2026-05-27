// CTL-660: pure pairing/latency helper for the dispatch-lifecycle events the
// execution-core scheduler/recovery now emit (phase.dispatch.requested.<T>,
// phase.dispatch.launched.<T>) plus the existing phase completion events
// (phase.<phase>.complete.<T>). Pairs them by (ticket, target_phase) and
// derives two durations:
//   • pickupMs    = launched − requested  (daemon-decided → worker-live)
//   • wallClockMs = complete − launched   (worker-live → phase done)
//
// Intentionally free of any Ink/React import so it stays trivially unit-
// testable (Phase 4 of the plan, Key Decision 5: HUD scope minimal).

import type { CanonicalEvent } from "../../lib/canonical-event.ts";

export interface DispatchLatency {
  /** ms epoch of phase.dispatch.requested (the dispatch decision). */
  requestedTs?: number;
  /** ms epoch of phase.dispatch.launched (verified live worker). */
  launchedTs?: number;
  /** ms epoch of phase.<phase>.complete. */
  completeTs?: number;
  /** launched − requested, present only when both ends exist. */
  pickupMs?: number;
  /** complete − launched, present only when both ends exist. */
  wallClockMs?: number;
}

// phase.<phaseSlot>.<action>.<ticket>. For dispatch events the phaseSlot is the
// literal "dispatch" and the real phase rides in body.payload.target_phase; for
// complete events the phaseSlot IS the real phase. The ticket tail is greedy so
// hyphenated ids (CTL-660) and any future dotted suffix stay intact.
const NAME_RE = /^phase\.([^.]+)\.(requested|launched|complete)\.(.+)$/;

function payloadOf(event: CanonicalEvent): Record<string, unknown> {
  const p = event?.body?.payload;
  return p && typeof p === "object" ? (p as Record<string, unknown>) : {};
}

/**
 * The `<ticket>:<phase>` key a dispatch/complete event contributes to, or null
 * when the event is not a lifecycle event (or a dispatch event missing
 * target_phase, which cannot be keyed). Exported so the HUD can look up the
 * single matched latency for a selected row without rebuilding the map shape.
 */
export function latencyKeyForEvent(event: CanonicalEvent): string | null {
  const name = event?.attributes?.["event.name"];
  if (typeof name !== "string") return null;
  const m = NAME_RE.exec(name);
  if (!m) return null;
  const [, phaseSlot, action, ticket] = m;
  if (action === "complete") return `${ticket}:${phaseSlot}`;
  const tp = payloadOf(event)["target_phase"];
  if (typeof tp !== "string" || tp.length === 0) return null;
  return `${ticket}:${tp}`;
}

/**
 * Reduce a window of canonical events into per-(ticket, phase) dispatch
 * latencies. Out-of-order arrival is tolerated (each action just stamps its
 * own field); durations are computed in a second pass once all events are
 * folded in. Events that are not lifecycle events, that carry an unparseable
 * ts, or that are dispatch events without a target_phase are skipped.
 */
export function computeDispatchLatencies(
  events: CanonicalEvent[],
): Map<string, DispatchLatency> {
  const map = new Map<string, DispatchLatency>();

  for (const event of events) {
    const name = event?.attributes?.["event.name"];
    if (typeof name !== "string") continue;
    const m = NAME_RE.exec(name);
    if (!m) continue;
    const [, phaseSlot, action, ticket] = m;

    let phase: string;
    if (action === "complete") {
      phase = phaseSlot;
    } else {
      const tp = payloadOf(event)["target_phase"];
      if (typeof tp !== "string" || tp.length === 0) continue;
      phase = tp;
    }

    const ts = Date.parse(event.ts);
    if (Number.isNaN(ts)) continue;

    const key = `${ticket}:${phase}`;
    const entry = map.get(key) ?? {};
    if (action === "requested") entry.requestedTs = ts;
    else if (action === "launched") entry.launchedTs = ts;
    else entry.completeTs = ts;
    map.set(key, entry);
  }

  for (const entry of map.values()) {
    if (entry.requestedTs !== undefined && entry.launchedTs !== undefined) {
      entry.pickupMs = entry.launchedTs - entry.requestedTs;
    }
    if (entry.launchedTs !== undefined && entry.completeTs !== undefined) {
      entry.wallClockMs = entry.completeTs - entry.launchedTs;
    }
  }

  return map;
}
