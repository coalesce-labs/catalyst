// heartbeat-event.mjs — CTL-859. Node-heartbeat event builder + best-effort
// appender, plus a small periodic emitter the daemon arms.
//
// PR1 of the distributed-coordination epic. Each daemon appends a
// `node.heartbeat` canonical event to the unified event log every
// HEARTBEAT_INTERVAL_MS so a future liveness reader (readClusterHeartbeats,
// recovery.mjs) can detect a dead node by heartbeat silence. ADDITIVE/dormant:
// emitting a heartbeat changes no dispatch/claim/eligible-query behavior — it is
// pure observability data on the shared log.
//
// Shape mirrors memory-event.mjs (OTel envelope, appendFileSync, never throws)
// so the orch-monitor/HUD/broker parsers treat the line identically. The
// resource block carries host.name + host.id from lib/host-identity.mjs, the
// same primitives every other execution-core MJS emitter uses.

import { mkdir, appendFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import {
  getEventLogPath,
  getHostName,
  HEARTBEAT_INTERVAL_MS,
  log,
  readGovernanceConfig,
} from "./config.mjs";
import { buildCatalystResource } from "./lib/catalyst-resource.mjs";
import { logDaemonHeartbeat } from "../lib/daemon-heartbeat.mjs";
import { emitProcessMemoryMetric } from "../lib/process-memory-metric.mjs"; // CTL-1517: per-process RSS/heap gauge

export const HEARTBEAT_EVENT = "node.heartbeat";

/**
 * buildHeartbeatEnvelope — assemble the canonical OTel envelope for a heartbeat.
 * Pure (modulo random ids + timestamp); no I/O.
 *
 * The payload carries the host name and an epoch (ms) so a reader can compute
 * liveness without re-parsing the ISO ts. `host` in the payload is resolved via
 * getHostName() (Layer-2 config aware), while the resource block uses the
 * lib/host-identity.mjs primitives shared across all three runtimes.
 *
 * @param {object} [opts]
 * @param {Function} [opts.now]  injectable timestamp fn (returns ISO string)
 * @param {Function} [opts.epochFn]  injectable epoch fn (returns ms number)
 * @param {Function} [opts.governanceFn]  injectable governance snapshot fn (CTL-1062)
 * @param {Function} [opts.admissionFn]  injectable admission-state fn (CTL-1322); the
 *   daemon supplies a closure over orchDir + concurrency. null when not supplied.
 * @param {Function} [opts.inFlightTicketsFn]  CTL-1420 (#17): injectable fn returning
 *   this host's in-flight ticket IDs (string[]); the daemon supplies the local
 *   signal-scan list. Defaults to [] for non-daemon callers/tests.
 * @param {Function} [opts.activeTicketsFn]  CTL-1581: injectable fn returning this
 *   host's ACTIVELY-RUNNING ticket IDs (running/dispatched signals only — the
 *   slot-OCCUPANCY signal, a subset of in_flight which also counts parked/
 *   needs-human dirs for cross-host ownership/reclaim). The Workers slot deck
 *   renders occupancy from this; conflating it with in_flight made the header
 *   count slots the deck (correctly) showed as Open.
 * @param {Function} [opts.maxParallelFn]  CTL-1551: injectable fn returning this
 *   host's live parallel-slot ceiling (positive integer, or null when unknown);
 *   the daemon supplies readLocalMaxParallel. Carried as a top-level ATTRIBUTE
 *   (body.payload is stripped before OTLP — otlp.ts:51) so a peer's monitor can
 *   render per-host capacity from Loki now that the Linear-anchor publish (the
 *   only prior cross-host max_parallel transport) is retired in loki mode.
 * @returns {object} the envelope object
 */
export function buildHeartbeatEnvelope({
  now,
  epochFn,
  governanceFn,
  admissionFn,
  inFlightTicketsFn,
  activeTicketsFn,
  maxParallelFn,
  boardReachableFn,
} = {}) {
  const ts = now ? now() : new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const epoch = epochFn ? epochFn() : Date.now();
  const host = getHostName();
  const governance = governanceFn ? governanceFn() : readGovernanceConfig();
  // CTL-1322: live admission state — { accepting, holdReason, effectiveCapacity,
  // activeWorkers } — so a draining/liveness-cold daemon is visible in telemetry
  // instead of hidden behind a healthy heartbeat. Supplied by the daemon; null for
  // non-daemon callers/tests so the key is always present for consumers.
  const admission = admissionFn ? admissionFn() : null;
  // CTL-1420 (#17): this host's in-flight ticket IDs, carried as top-level ATTRIBUTES
  // (not body.payload — otlp.ts:51 strips payload; only attributes reach Loki). A
  // dotted attr key becomes Loki STRUCTURED METADATA (catalyst_node_in_flight_tickets),
  // NOT an indexed stream label (collector-config cardinality rule), so a changing
  // per-line value is safe. This is the cross-host ownership signal that lets a peer
  // reclaim a dead host's work by reading Loki instead of the Linear heartbeat
  // attachment. Comma-joined so the OTLP string attribute survives verbatim; count is
  // a low-card int for dashboards. Fail-safe: a non-array fn result → [].
  const inFlightRaw = inFlightTicketsFn ? inFlightTicketsFn() : [];
  const inFlightTickets = Array.isArray(inFlightRaw)
    ? inFlightRaw.filter((t) => typeof t === "string" && t.length > 0)
    : [];
  // CTL-1581: same fail-safe shaping for the occupancy subset.
  const activeRaw = activeTicketsFn ? activeTicketsFn() : [];
  const activeTickets = Array.isArray(activeRaw)
    ? activeRaw.filter((t) => typeof t === "string" && t.length > 0)
    : [];
  // CTL-1551: live slot ceiling as a Loki-reachable attribute (low-card int →
  // structured metadata, same rationale as in_flight_count). Fail-safe: a
  // missing/invalid value → attribute omitted, never a fake 0 (the monitor
  // treats "absent" as no-data, but a literal 0 would render as zero capacity).
  const mpRaw = maxParallelFn ? maxParallelFn() : null;
  const maxParallel = Number.isInteger(mpRaw) && mpRaw > 0 ? mpRaw : null;
  let board = null;
  if (boardReachableFn) {
    try {
      board = boardReachableFn();
    } catch {
      board = { reachable: true, blindTeams: 0 };
    }
  }

  return {
    ts,
    id: randomBytes(8).toString("hex"),
    observedTs: ts,
    severityText: "INFO",
    severityNumber: 9,
    traceId: null,
    spanId: null,
    resource: buildCatalystResource({ serviceName: "catalyst.execution-core", host }),
    attributes: {
      "event.name": HEARTBEAT_EVENT,
      "event.entity": "node",
      "event.action": "heartbeat",
      "event.label": host,
      // CTL-1420 (#17): Loki-queryable cross-host liveness+ownership signal.
      "catalyst.node.in_flight_tickets": inFlightTickets.join(","),
      "catalyst.node.in_flight_count": inFlightTickets.length,
      // CTL-1581: slot-OCCUPANCY signal (running/dispatched only — parked
      // needs-human dirs are owned but hold no slot; the scheduler's own slot
      // accounting agrees). The Workers deck renders occupied boxes from this.
      "catalyst.node.active_tickets": activeTickets.join(","),
      "catalyst.node.active_count": activeTickets.length,
      // CTL-1551: Loki-queryable cross-host capacity signal (omitted when unknown).
      ...(maxParallel != null ? { "catalyst.node.max_parallel": maxParallel } : {}),
      ...(board ? {
        "catalyst.node.board_reachable": board.reachable !== false,
        ...(board.blindTeams != null ? { "catalyst.node.blind_teams": board.blindTeams } : {}),
      } : {}),
    },
    body: {
      payload: {
        "host.name": host,
        epoch,
        governance, // CTL-1062: live governance snapshot for operator visibility
        admission, // CTL-1322: live new-work admission state (accepting + holdReason)
      },
    },
  };
}

/**
 * emitHeartbeatEvent — build + append one heartbeat envelope line to the unified
 * event log. Returns true on success, false on any failure (best-effort; never
 * throws). `logPath` is injectable for tests; defaults to the same
 * getEventLogPath() every other emitter uses (no new log path).
 */
export async function emitHeartbeatEvent({
  logPath = getEventLogPath(),
  now,
  epochFn,
  // CTL-1322: thread the injectable seams through to the builder. The prior signature
  // didn't accept governanceFn (a dormant seam gap), so an injected governanceFn never
  // reached buildHeartbeatEnvelope from here; now both governanceFn + admissionFn flow.
  governanceFn,
  admissionFn,
  inFlightTicketsFn, // CTL-1420 (#17): forward the in-flight-tickets seam to the builder
  activeTicketsFn, // CTL-1581: forward the slot-occupancy seam to the builder
  maxParallelFn, // CTL-1551: forward the slot-ceiling seam to the builder
  boardReachableFn,
} = {}) {
  const line = `${JSON.stringify(buildHeartbeatEnvelope({ now, epochFn, governanceFn, admissionFn, inFlightTicketsFn, activeTicketsFn, maxParallelFn, boardReachableFn }))}\n`;
  try {
    await mkdir(dirname(logPath), { recursive: true });
    await appendFile(logPath, line);
    return true;
  } catch (err) {
    log.warn({ err: err?.message }, "heartbeat-event: event append failed");
    return false;
  }
}

/**
 * startHeartbeat — arm a periodic heartbeat emitter. Fires one heartbeat
 * immediately, then every intervalMs. Returns a stop handle ({ stop() }) so the
 * daemon can tear it down symmetrically with its other timers. The interval is
 * unref'd so it never holds the process open.
 *
 * @param {object} [opts]
 * @param {number} [opts.intervalMs]  cadence; defaults to HEARTBEAT_INTERVAL_MS
 * @param {string} [opts.logPath]     event-log path (injectable for tests)
 * @param {Function} [opts.admissionFn]  CTL-1322: live admission-state fn (daemon-supplied)
 * @param {Function} [opts.governanceFn] CTL-1062: live governance snapshot fn (optional override)
 * @param {Function} [opts.inFlightTicketsFn] CTL-1420 (#17): live in-flight-tickets fn (daemon-supplied)
 * @param {Function} [opts.activeTicketsFn] CTL-1581: live slot-occupancy fn (daemon-supplied)
 * @param {Function} [opts.maxParallelFn] CTL-1551: live slot-ceiling fn (daemon-supplied)
 */
export function startHeartbeat({ intervalMs = HEARTBEAT_INTERVAL_MS, logPath, admissionFn, governanceFn, inFlightTicketsFn, activeTicketsFn, maxParallelFn, boardReachableFn } = {}) {
  const tick = () => {
    // CTL-1280: deterministic liveness heartbeat to daemon.log (Alloy→Loki),
    // riding the same cadence as the node.heartbeat event but on the .log stream
    // so a liveness check can watch the heartbeat marker independent of the
    // otel-forward event pipeline (a quiet-but-healthy daemon must still prove it).
    logDaemonHeartbeat(log, "execution-core");
    // CTL-1517: per-process RSS/heap OTel gauge on the same tick (fire-and-forget; never
    // throws, never blocks) so per-daemon memory becomes attributable in Prometheus.
    emitProcessMemoryMetric({ serviceName: "catalyst.execution-core", log }).catch(() => {});
    return emitHeartbeatEvent({ logPath, admissionFn, governanceFn, inFlightTicketsFn, activeTicketsFn, maxParallelFn, boardReachableFn }).catch(() => {});
  };
  const started = tick(); // emit once at boot; Promise for callers that need to await it
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return {
    stop() {
      clearInterval(timer);
    },
    started, // resolves after the first heartbeat write attempt
  };
}
