// ingestion-recency.mjs — pure recency classification for the CTL-1122 ingestion-silence
// detector. Shared, dependency-free .mjs (the phase-fsm.mjs precedent): importable by the
// broker/exec-core (.mjs) and by orch-monitor TS tests with zero build step.
//
// FAIL-OPEN BY CONSTRUCTION (the load-bearing invariant): a source we have never observed
// (lastSeenTs == null) classifies as "unknown", NEVER "down". We never alarm on the absence
// of evidence — only on evidence of staleness (a source we HAVE seen that has since gone
// quiet past the threshold). This is the discriminated fail-open the design review (D3 MINOR 5)
// required: read-error / never-seen → unknown (no alarm); seen-but-stale → degraded/down.
//
// This module does NO I/O. The host (the broker tailer) tracks last-seen timestamps per
// service in memory and passes them here; there is deliberately no full-file reader (the
// review's D2 BLOCKER: re-reading the multi-hundred-MB log per tick blocks the event loop).

/**
 * Age in ms of the newest observation, or null when there is no usable observation.
 * Clamps clock-skew (a future timestamp) to 0 (treated as fresh), never negative.
 * @param {number|string|null|undefined} lastSeenTs epoch ms, or an ISO string, or null
 * @param {number} nowMs
 * @returns {number|null}
 */
export function recencyAgeMs(lastSeenTs, nowMs) {
  if (lastSeenTs == null) return null;
  const t = typeof lastSeenTs === "number" ? lastSeenTs : Date.parse(lastSeenTs);
  if (!Number.isFinite(t)) return null;
  const age = nowMs - t;
  return age >= 0 ? age : 0;
}

/**
 * Classify a recency age against thresholds. ageMs == null → "unknown" (fail-open).
 * @param {number|null} ageMs
 * @param {{degradedAfterMs:number, downAfterMs:number}} thresholds
 * @returns {"up"|"degraded"|"down"|"unknown"}
 */
export function classifyRecency(ageMs, { degradedAfterMs, downAfterMs }) {
  if (ageMs == null) return "unknown";
  if (!(downAfterMs > 0) || !(degradedAfterMs > 0)) return "unknown"; // misconfigured → no alarm
  if (ageMs >= downAfterMs) return "down";
  if (ageMs >= degradedAfterMs) return "degraded";
  return "up";
}

/**
 * Combined helper: compute age from a last-seen timestamp and classify it.
 * @param {{lastSeenTs:number|string|null|undefined, nowMs:number, degradedAfterMs:number, downAfterMs:number}} i
 * @returns {{ageMs:number|null, severity:"up"|"degraded"|"down"|"unknown"}}
 */
export function evaluateSource({ lastSeenTs, nowMs, degradedAfterMs, downAfterMs }) {
  const ageMs = recencyAgeMs(lastSeenTs, nowMs);
  return { ageMs, severity: classifyRecency(ageMs, { degradedAfterMs, downAfterMs }) };
}
