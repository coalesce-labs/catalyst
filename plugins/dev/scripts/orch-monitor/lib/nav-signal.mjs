// nav-signal.mjs — the dedicated NAV-SIGNAL projection (CTL-896 / SHELL6).
//
// The vertical rail's payoff is per-item live signal a top tab strip can't carry
// (app-shell research §2 "Live badges are the payoff"). This module is the single
// cache-backed projection that feeds those badges/dots: the Workers active-count
// badge, the Queue depth badge, the Board anomaly dot, and the footer daemon-
// health dot. It is PURE + injectable so the exact scenarios are unit-testable
// without an fs/DB/subprocess, and it derives EXCLUSIVELY off the read-model's
// already-assembled board snapshot (BoardPayload) plus an injected daemon-liveness
// status — it NEVER does a synchronous per-request scan of the source files (the
// load-bearing ticket constraint). The server layers it onto the SAME reactive
// boardSnapshot the board SSE already pushes, so a nav badge update rides the
// read-model SSE stream, not a per-tab poll.
//
// SINGLE-HOST IDENTITY NO-OP: daemon health is the LOCAL node's liveness. On
// today's single-node deployment (hosts.json absent → getClusterHosts() returns
// [localHostName]), the read-model classifies the one local daemon's own
// node.heartbeat freshness via node-liveness.mjs::classifyHostLiveness — exactly
// one node, the local one, zero cross-node transport. The N>1 fleet-health roll-up
// is a later cluster concern (BFF3); here the daemon dot reflects the local daemon
// and nothing else.

import {
  classifyHostLiveness,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
} from "./node-liveness.mjs";

// CTL-1169: hysteresis for the daemon-health DOT/notification path.
//
// classifyHostLiveness calls a host "live" only while its last heartbeat is ≤ one
// 30s interval old — but the daemon emits on that SAME 30s cadence, so real-world
// jitter (measured gaps: median ~35s, spikes to 60–100s) routinely pushes the age
// just past 30s before the next (late) beat lands. With the desktop app firing a
// notification on every healthy↔degraded transition, that boundary-flap becomes a
// notification storm. So the daemon-health classification uses a wider "healthy"
// window than the raw cluster-liveness overlay: ~3 missed beats. This is ONLY the
// nav daemon-health projection — the cluster overlay (overlayClusterLiveness) keeps
// the tight 30s/5min eviction window. A genuinely overdue daemon still degrades
// (≥3 missed beats) and still goes offline at the 5min grace. Tune via the server
// env override (MONITOR_DAEMON_HEALTHY_WINDOW_MS); the real fix for the >60s gaps is
// CTL-1170 (stop the event-loop stalls), after which this window can shrink.
export const DEFAULT_DAEMON_HEALTHY_WINDOW_MS = 3 * DEFAULT_HEARTBEAT_INTERVAL_MS;

/**
 * @typedef {"healthy" | "degraded" | "offline"} DaemonHealth
 */

/**
 * @typedef {object} NavSignal
 * @property {number} workerCount   active execution-core workers (the Workers badge)
 * @property {number} queueDepth    tickets waiting in the queue (the Queue badge)
 * @property {boolean} anomaly      a board anomaly exists — blocked/needs-human or a stuck worker (the Board dot)
 * @property {DaemonHealth} daemon  the local daemon's liveness (the footer health dot)
 * @property {string} generatedAt   the source snapshot's generatedAt (passthrough for cache/debug)
 */

/** node-liveness `live`/`degraded`/`offline` → the nav daemon-health vocabulary. */
function daemonFromLiveness(status) {
  if (status === "live") return "healthy";
  if (status === "degraded") return "degraded";
  return "offline";
}

/**
 * deriveNavSignal — project the four nav signals off the read-model's board
 * snapshot + the local daemon's liveness. Pure: no fs, no clock, no subprocess —
 * everything is read off the passed snapshot and the injected `daemon`/`liveness`.
 *
 * Anomaly discipline (color: amber dot): a board anomaly is a ticket the operator
 * must look at — one held `blocked` (the in-payload representation of a dependency
 * hold / needs-human) OR a stuck worker (config.stuck). A `waiting` hold is NOT an
 * anomaly: deps are satisfied, it is just awaiting capacity (home-inbox.ts split).
 *
 * @param {import("./board-data.mjs").BoardPayload | null | undefined} board
 * @param {{ daemon?: DaemonHealth, liveness?: "live"|"degraded"|"offline" }} [opts]
 *   `daemon` sets the health vocabulary directly; `liveness` maps a node-liveness
 *   status through. When neither is given the daemon defaults to "offline" (the
 *   read-model never fabricates health for a daemon it has not heard from).
 * @returns {NavSignal}
 */
export function deriveNavSignal(board, { daemon, liveness } = {}) {
  const workers = Array.isArray(board?.workers) ? board.workers : [];
  const queue = Array.isArray(board?.queue) ? board.queue : [];
  const tickets = Array.isArray(board?.tickets) ? board.tickets : [];
  const stuck = typeof board?.config?.stuck === "number" ? board.config.stuck : 0;

  const blocked = tickets.some((t) => t && t.held === "blocked");
  // CTL-1180: a needs-human ticket (incl. a surfaced failed phase) lights the dot
  // even when it carries no admission hold.
  const needsHuman = tickets.some((t) => t && t.attention === "needs-human");
  const anomaly = blocked || needsHuman || stuck > 0;

  const resolvedDaemon =
    daemon ?? (liveness ? daemonFromLiveness(liveness) : "offline");

  return {
    workerCount: workers.length,
    queueDepth: queue.length,
    anomaly,
    daemon: resolvedDaemon,
    generatedAt:
      typeof board?.generatedAt === "string" ? board.generatedAt : "",
  };
}

/**
 * deriveDaemonHealth — classify the LOCAL daemon's liveness from the heartbeat
 * last-seen map (recovery.readClusterHeartbeats output: { [hostName]: lastSeenISO })
 * for the local host. Single-host identity no-op: the local host's own heartbeat IS
 * the daemon's health. Pure: `now` and the local host name are injected.
 *
 * @param {Record<string, string>} lastSeenByHost  readClusterHeartbeats output
 * @param {string} localHostName  the local node's name (config.getHostName / hostName())
 * @param {{ now?: number, intervalMs?: number, graceMs?: number }} [opts]
 *   `intervalMs` is the "healthy" window and defaults to
 *   DEFAULT_DAEMON_HEALTHY_WINDOW_MS (CTL-1169 hysteresis), NOT one raw heartbeat
 *   interval — so normal heartbeat jitter does not flap the footer dot. Pass an
 *   explicit value (e.g. from MONITOR_DAEMON_HEALTHY_WINDOW_MS) to override.
 * @returns {DaemonHealth}
 */
export function deriveDaemonHealth(
  lastSeenByHost,
  localHostName,
  { now = Date.now(), intervalMs = DEFAULT_DAEMON_HEALTHY_WINDOW_MS, graceMs } = {},
) {
  const seen =
    lastSeenByHost && typeof lastSeenByHost === "object" ? lastSeenByHost : {};
  const lastSeen =
    typeof localHostName === "string" &&
    typeof seen[localHostName] === "string" &&
    seen[localHostName].length > 0
      ? seen[localHostName]
      : null;
  return daemonFromLiveness(
    classifyHostLiveness(lastSeen, now, { intervalMs, graceMs }),
  );
}
