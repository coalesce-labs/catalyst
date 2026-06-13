// liveness-roster.mjs — CTL-1091: liveness-aware HRW roster with anti-flap hysteresis.
//
// PROBLEM: scheduler/monitor pass the FULL static roster (.catalyst/hosts.json) to
// hrw.ownedBy(). A roster member whose daemon is offline still wins ~1/N of tickets
// by HRW argmax — and being offline, that share of the backlog is filtered out on
// every live host and never gets worked.
//
// FIX: filter the roster to LIVE hosts before ownership evaluation. ownedBy(ticket,
// liveHosts, self) then re-homes an offline host's share to the survivors. The
// cluster is already serialized by cluster-claim's Linear CAS, so a transient
// liveness disagreement at most causes a claim race that exactly one host wins.
//
// HYSTERESIS (ticket requirement): a host is shed only after N consecutive "down"
// ticks and restored only after N consecutive "up" ticks, so a lid-close / brief
// wake doesn't flap ownership. Symmetric and STATEFUL across ticks.
//
// DELIBERATE DIVERGENCE FROM recovery.deadHosts: deadHosts treats a never-seen host
// as ALIVE ("not our call to make" with per-host local logs). HERE a never-seen host
// is treated as DOWN — CTL-1091 says "a roster member that is never live is
// equivalent to absent" (the CTL-1057 case). So we compute our OWN down-signal
// (never-seen OR stale-past-grace) rather than calling deadHosts.
//
// SELF INVARIANT: the host running this tick is provably alive, so `self` is NEVER
// shed regardless of what the heartbeat feed says about it.

import { readClusterHeartbeats } from "./recovery.mjs";
import {
  HEARTBEAT_GRACE_MS,
  HEARTBEAT_INTERVAL_MS,
  LIVENESS_SHED_THRESHOLD,
} from "./config.mjs";

// stepLivenessHysteresis — PURE. Given the previous per-host state and this tick's
// inputs, return { state, liveHosts, transitions }.
//   prevState: { [host]: { downStreak, upStreak, shed } }  (missing host ⇒ fresh, not shed)
//   transitions: [{ host, to: "shed" | "restored" }]  — flips THIS tick (for logging)
export function stepLivenessHysteresis(
  prevState,
  { roster, self, lastSeen, graceMs, nowMs, threshold }
) {
  const cutoff = nowMs - graceMs;
  const state = {};
  const transitions = [];
  for (const host of roster) {
    const prev = prevState[host] ?? { downStreak: 0, upStreak: 0, shed: false };
    const seen = lastSeen?.[host];
    // down-signal: never-seen OR last heartbeat older than the grace window.
    const down = !seen || !(Date.parse(seen) >= cutoff);
    let { downStreak, upStreak, shed } = prev;
    if (down) {
      downStreak += 1;
      upStreak = 0;
      if (!shed && downStreak >= threshold) {
        shed = true;
        transitions.push({ host, to: "shed" });
      }
    } else {
      upStreak += 1;
      downStreak = 0;
      if (shed && upStreak >= threshold) {
        shed = false;
        transitions.push({ host, to: "restored" });
      }
    }
    state[host] = { downStreak, upStreak, shed };
  }
  // self is provably alive — never shed it, whatever the feed says.
  let liveHosts = roster.filter((h) => h === self || !state[h]?.shed);
  // Pathological all-shed → fall back to the full static roster: a possible
  // double-claim (serialized by CAS) beats total backlog starvation.
  if (liveHosts.length === 0) liveHosts = roster.slice();
  return { state, liveHosts, transitions };
}

// ── stateful wrapper ─────────────────────────────────────────────────────────
// Module-level state persists across ticks within one daemon process. A restart
// re-learns within `threshold` ticks. _cache spares the webhook-driven monitor
// path the up-to-15s readClusterHeartbeats spawnSync on every call.
let _hysteresisState = {};
let _cache = { lastSeen: null, expiresAtMs: 0 };

export function __resetLivenessState() {
  _hysteresisState = {};
  _cache = { lastSeen: null, expiresAtMs: 0 };
}

// effectiveLiveRoster — the entry point scheduler.mjs + monitor.mjs call. A
// single-host roster is an EXACT no-op (returns roster, never reads heartbeats).
export function effectiveLiveRoster({
  roster,
  self,
  graceMs = HEARTBEAT_GRACE_MS,
  threshold = LIVENESS_SHED_THRESHOLD,
  nowMs = Date.now(),
  cacheMs = HEARTBEAT_INTERVAL_MS,
  readHeartbeats = readClusterHeartbeats,
  log = null,
} = {}) {
  if (!Array.isArray(roster) || roster.length <= 1) return roster; // exact no-op

  let lastSeen;
  if (_cache.lastSeen && nowMs < _cache.expiresAtMs) {
    lastSeen = _cache.lastSeen;
  } else {
    try {
      lastSeen = readHeartbeats({ roster }) ?? {};
    } catch {
      lastSeen = {}; // fail-open: a Linear hiccup must never break dispatch
    }
    _cache = { lastSeen, expiresAtMs: nowMs + cacheMs };
  }

  const { state, liveHosts, transitions } = stepLivenessHysteresis(_hysteresisState, {
    roster,
    self,
    lastSeen,
    graceMs,
    nowMs,
    threshold,
  });
  _hysteresisState = state;
  // Phase 4: observability hook — emit exactly one log line per shed/restore flip.
  if (log && transitions.length) {
    for (const t of transitions) {
      log.info({ host: t.host, self, roster }, `ctl-1091: host ${t.to} live-roster`);
    }
  }
  return liveHosts;
}
