// node-liveness.mjs — the cluster liveness overlay (CTL-884, BFF2).
//
// The read-model's node-aware cluster view marks every roster host live /
// degraded / offline from the heartbeat last-seen timestamps that
// recovery.readClusterHeartbeats({logPath}) yields ({ [hostName]: lastSeenISO }).
// Daemons append one `node.heartbeat` event to the unified event log every
// ~30s (execution-core/config.mjs HEARTBEAT_INTERVAL_MS), so a host's freshness
// classifies as:
//
//   • live      — heard within one heartbeat interval (≤ intervalMs ago)
//   • degraded  — past the interval but inside the generous grace window
//   • offline   — past the grace window, OR never heard / unparseable timestamp
//
// The grace window is deliberately generous (5-10 min per the design doc) so a
// host that legitimately stalls 1-2 min (Claude API latency, a long implement)
// is NEVER false-evicted as offline.
//
// SINGLE-HOST IDENTITY NO-OP: for today's single-node deployment the roster is
// [getHostName()] (config.mjs::getClusterHosts) and readClusterHeartbeats reads
// the ONE local event log — so overlayClusterLiveness yields exactly one node
// entry whose status reflects the local daemon's own heartbeat. There is no
// cross-node transport here; that is BFF3's concern. This module is pure and
// injectable (`now`/thresholds) so the classification is unit-testable without a
// real event log.

// node-heartbeat cadence (mirrors execution-core/config.mjs HEARTBEAT_INTERVAL_MS
// — copied as a literal so this lightweight monitor lib does not pull the daemon
// module into its import graph; the heartbeat-cadence drift is bounded by the
// node-liveness test, the same pattern board-data.mjs uses for the held labels).
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;

// Liveness grace window — the design doc prescribes 5-10 min to bias hard against
// false eviction. We use 5 min (the floor) so a host is declared offline no
// sooner than the design allows.
export const DEFAULT_LIVENESS_GRACE_MS = 5 * 60_000;

/**
 * classifyHostLiveness — map a host's last-seen heartbeat timestamp to a
 * liveness status. Pure: `now` and the thresholds are injected. Never throws —
 * a null / empty / unparseable timestamp degrades to "offline" (the read-model
 * never fabricates liveness for a host it has not heard from). A future-dated
 * heartbeat (clock skew) clamps to age 0 → live, never negative-age garbage.
 *
 * @param {string | null | undefined} lastSeenISO
 * @param {number} now epoch ms
 * @param {{ intervalMs?: number, graceMs?: number }} [opts]
 * @returns {"live" | "degraded" | "offline"}
 */
export function classifyHostLiveness(
  lastSeenISO,
  now,
  { intervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS, graceMs = DEFAULT_LIVENESS_GRACE_MS } = {},
) {
  if (typeof lastSeenISO !== "string" || lastSeenISO.length === 0) return "offline";
  const seen = Date.parse(lastSeenISO);
  if (!Number.isFinite(seen)) return "offline";
  // Clamp clock skew: a heartbeat from the future is age 0, never negative.
  const ageMs = Math.max(0, now - seen);
  if (ageMs <= intervalMs) return "live";
  if (ageMs <= graceMs) return "degraded";
  return "offline";
}

/**
 * mergeHeartbeatsNewestWins — merge any number of { host: lastSeenISO } maps,
 * keeping the NEWER timestamp per host (CTL-1255). The monitor folds the
 * cross-host LIVENESS ANCHOR heartbeats (coarse ~2-min cadence) over the LOCAL
 * event-log heartbeats (~30s). A plain spread ({...local, ...anchor}) let the
 * anchor's older timestamp CLOBBER the fresher local heartbeat for the self
 * host, so a live local node displayed "degraded". Newest-wins fixes that while
 * still surfacing peers that exist only in the anchor. An unparseable timestamp
 * loses to any parseable one; never throws.
 *
 * @param {...Record<string, string>} maps
 * @returns {Record<string, string>}
 */
export function mergeHeartbeatsNewestWins(...maps) {
  const out = {};
  for (const m of maps) {
    if (!m || typeof m !== "object") continue;
    for (const [host, ts] of Object.entries(m)) {
      if (typeof ts !== "string" || ts.length === 0) continue;
      const prev = out[host];
      if (prev === undefined) {
        out[host] = ts;
        continue;
      }
      const prevMs = Date.parse(prev);
      const tsMs = Date.parse(ts);
      if (!Number.isFinite(prevMs)) {
        out[host] = ts; // any later value beats an unparseable earlier one
      } else if (Number.isFinite(tsMs) && tsMs > prevMs) {
        out[host] = ts;
      }
    }
  }
  return out;
}

/**
 * overlayClusterLiveness — overlay liveness across an entire roster. Returns one
 * node entry per roster host (stable roster order), carrying its status and the
 * lastSeen timestamp the overlay classified (null when the host was never heard).
 * A host absent from the lastSeen map is offline.
 *
 * @param {string[]} hosts the cluster roster (config.mjs::getClusterHosts)
 * @param {Record<string, string>} lastSeenByHost readClusterHeartbeats output
 * @param {{ now?: number, intervalMs?: number, graceMs?: number }} [opts]
 * @returns {Array<{ host: string, status: "live"|"degraded"|"offline", lastSeen: string | null }>}
 */
export function overlayClusterLiveness(
  hosts,
  lastSeenByHost,
  { now = Date.now(), intervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS, graceMs = DEFAULT_LIVENESS_GRACE_MS } = {},
) {
  const roster = Array.isArray(hosts) ? hosts : [];
  const seen = lastSeenByHost && typeof lastSeenByHost === "object" ? lastSeenByHost : {};
  return roster.map((host) => {
    const lastSeen = typeof seen[host] === "string" && seen[host].length > 0 ? seen[host] : null;
    return {
      host,
      status: classifyHostLiveness(lastSeen, now, { intervalMs, graceMs }),
      lastSeen,
    };
  });
}
