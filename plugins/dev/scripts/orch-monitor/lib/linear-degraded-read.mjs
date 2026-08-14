// linear-degraded-read.mjs — CTL-1806 (D3). The ONE place orch-monitor declares
// that it is about to talk to the rate-limited Linear GraphQL API.
//
// AC3: "a replica miss is loud, not a silent API call". The anomaly worth
// alarming on is not "a reader failed" — the replica readers
// (readReplicaTitles / readReplicaEstimates / readReplicaTicketDetails) are
// deliberately SILENT fail-open, and they must stay that way, because their
// fall-through is to another LOCAL source. The anomaly is "a Linear API call is
// about to happen". So the emission sits on the DEGRADED PATH, immediately
// before the fetch — never on the reader. That placement makes the signal
// impossible to reach without an actual outbound call, and impossible to skip
// when the call throws or times out (an emission placed AFTER the fetch is lost
// on exactly the failures worth knowing about).
//
// WHY THIS MODULE AND NOT recordDaemonRead: linear-query.mjs's recordDaemonRead
// hardcodes serviceName "catalyst.execution-core". Reusing it would attribute
// orch-monitor's reads to the daemon and corrupt the very metric this ticket
// exists to move. emitLinearReadEvent is already exported and already imported
// cross-package (broker/cache-reconcile.mjs), so a third package importing it is
// precedent, not a new seam. This wrapper exists so the serviceName is declared
// ONCE rather than re-typed at each call site.
//
// The static import is vite-safe: emitLinearReadEvent's transitive static graph
// is 5 modules of node builtins + catalyst-resource + secret-contract, with NO
// `bun:` specifier anywhere — unlike replica-read.mjs, which is why THAT one is
// reached only through linear-cache-reader's computed dynamic specifier.
import { emitLinearReadEvent } from "../../execution-core/linear-read-event.mjs";

/** service.name stamped on every orch-monitor Linear read event. */
export const ORCH_MONITOR_SERVICE = "catalyst.orch-monitor";

/**
 * noteDegradedLinearRead — emit one `catalyst.linear.read` for a Linear API call
 * this process is making because a local source could not serve the read.
 *
 * Call it IMMEDIATELY BEFORE the outbound request, not after.
 *
 * `result` records whether the degraded call could be DISPATCHED — the only
 * thing knowable at the emission point, and deliberately so (see above):
 *   - "ok"     → the request is being sent to Linear.
 *   - "failed" → the degraded path was reached but no call could be made at all
 *                (no credential resolved). Stamps WARN/13, which is right: a
 *                node that silently returns nulls because it has no Linear token
 *                is the failure this telemetry most needs to surface.
 *
 * `source` distinguishes WHY we are here:
 *   - "linearis_miss" → a replica WAS consulted and missed.
 *   - "linearis"      → no replica was consulted (no replica source exists for
 *                       this read — the team estimation method, D1).
 *
 * Best-effort and never throws: emitLinearReadEvent swallows its own errors and
 * returns false (CTL-988 — a telemetry tap must never be able to fail the read
 * that called it).
 *
 * @param {{source: string, result: "ok"|"failed", op: string, entity?: string|null}} fields
 * @param {{logPath?: string, now?: Function}} [opts] injectable for tests
 * @returns {boolean} true when the line was appended
 */
export function noteDegradedLinearRead({ source, result, op, entity = null }, opts = {}) {
  return emitLinearReadEvent(
    { source, result, op, entity, serviceName: ORCH_MONITOR_SERVICE },
    opts
  );
}
