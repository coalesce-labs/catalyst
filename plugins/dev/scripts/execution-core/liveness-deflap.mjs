// liveness-deflap.mjs — CTL-1091 Phase 2. Restore-side deflap (hysteresis) for
// the DISPATCH ownership roster.
//
// The shed side already has hysteresis: computeSurvivingRoster only drops a host
// after HEARTBEAT_GRACE_MS (~10 min ≈ 20 missed heartbeats). The restore side had
// none — a host that flaps back (laptop lid re-opens) would immediately re-enter
// the roster, grab its HRW slice, then strand it on the next lid-close. This
// module adds a symmetric restore hold: a host that transitioned dead→live must
// be observed continuously live for holdMs before it re-enters the dispatch
// roster. During the hold the surviving peer keeps covering the slice, so there
// is NO starvation gap — the recovering host merely defers RE-TAKING new work.
//
// Applies to the DISPATCH roster only (not recovery — see plan Phase 2 Overview):
// recovery keeps its grace-only surviving roster.
//
// Per-host observation state is a tiny `{ <host>: { liveSince: <ms>|null } }` map
// the caller persists (scheduler is the sole writer; monitor reads it read-only).

import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";

// The on-disk observation-state file, relative to an orchestrator dir.
export const DEFLAP_STATE_FILE = ".liveness-deflap.json";

// computeDispatchRoster — apply the restore-side deflap to the surviving roster.
//
// A host present in `survivingRoster` (currently live) is admitted to the
// DISPATCH roster only once it has been continuously live for `holdMs`, tracked
// via a per-host `liveSince` timestamp. Semantics of `prevState[h]`:
//   • absent entry            → first observation / cold start. Treated as
//                               already past the hold (admit) so a cold start
//                               does NOT transiently shed every live host.
//   • { liveSince: <number> } → continuously live. Keep the timestamp; admit
//                               once nowMs - liveSince >= holdMs.
//   • { liveSince: null }     → was explicitly dead last tick → newly restored.
//                               Start the hold now (liveSince = nowMs); hold out
//                               until the window elapses.
// A host ABSENT from `survivingRoster` (shed/dead) resets its liveSince to null,
// so a later re-join restarts the whole hold (deflap).
//
// `self` is never held AND never shed — a host always owns its OWN work, even
// when it is absent from `survivingRoster` (a not-yet-heartbeated fresh start or
// a stale/laggy self-heartbeat read). The self guard is hoisted above the
// shed branch so it is reached regardless of self's observed liveness (CTL-1091
// correctness review #1).
//
// FAIL-SAFE: if the filter would empty the dispatch roster (e.g. a total liveness
// outage degraded survivingRoster to the full roster on a cold start where every
// host looks newly-restored), degrade to the surviving roster unchanged — deflap
// must never strand the whole board.
//
// Pure. Returns { dispatchRoster, nextState }; the caller persists nextState.
export function computeDispatchRoster({
  survivingRoster,
  roster,
  prevState = {},
  holdMs,
  nowMs,
  self,
} = {}) {
  const surviving = new Set(survivingRoster ?? []);
  const nextState = {};
  const dispatchRoster = [];

  for (const h of roster ?? []) {
    // self is ALWAYS admitted to its OWN dispatch roster and never held — this
    // guard is hoisted ABOVE the surviving.has() gate on purpose. A host must
    // never defer or re-home its own HRW slice based on its own observed
    // liveness: on a fresh daemon start (self has not emitted its first heartbeat
    // yet) or a stale/laggy self-heartbeat read, self is absent from the live
    // `survivingRoster` and would otherwise fall into the `!surviving.has(h)`
    // shed branch below BEFORE this self guard was ever reached — silently
    // re-homing self's slice to a peer during the warmup window (CTL-1091
    // correctness review #1). Keeping the guard first makes the documented
    // "self never held / never double-acts" invariant hold regardless of whether
    // self appears in the live set this tick.
    if (self !== undefined && h === self) {
      const liveSince = nowMs - holdMs;
      nextState[h] = { liveSince };
      dispatchRoster.push(h);
      continue;
    }

    if (!surviving.has(h)) {
      // Shed / dead this tick → reset the restore hold; not dispatch-eligible.
      nextState[h] = { liveSince: null };
      continue;
    }

    // Host is currently live — resolve its continuous-live-since timestamp.
    let liveSince;
    const entry = prevState[h];
    if (!entry || !Object.prototype.hasOwnProperty.call(entry, "liveSince")) {
      // Cold start: treat as already past the hold (admit) — no transient shed.
      liveSince = nowMs - holdMs;
    } else if (typeof entry.liveSince === "number") {
      liveSince = entry.liveSince; // continuously live — keep the running hold
    } else {
      // Explicit null → was dead, now restored → start the hold now.
      liveSince = nowMs;
    }

    nextState[h] = { liveSince };
    if (nowMs - liveSince >= holdMs) dispatchRoster.push(h);
  }

  if (dispatchRoster.length === 0) {
    // Never strand: degrade to the surviving roster (fail-safe).
    return { dispatchRoster: [...surviving], nextState };
  }
  return { dispatchRoster, nextState };
}

// readDeflapState — the persisted per-host observation map for an orchestrator
// dir. Absent file / parse failure → {} (no prior observations → cold start).
// Never throws — a corrupt file must not wedge the tick.
export function readDeflapState(orchDir) {
  if (!orchDir) return {};
  try {
    const raw = readFileSync(join(orchDir, DEFLAP_STATE_FILE), "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

// writeDeflapState — atomically persist the observation map (tmp + rename), the
// same pattern the fence-token / cluster-generation writes use. Best-effort: a
// write failure is swallowed (the next tick recomputes from whatever survived).
// The scheduler tick is the SOLE writer; monitor only reads.
export function writeDeflapState(orchDir, nextState) {
  if (!orchDir) return;
  const dest = join(orchDir, DEFLAP_STATE_FILE);
  const tmp = `${dest}.tmp.${process.pid}`;
  try {
    writeFileSync(tmp, JSON.stringify(nextState ?? {}));
    renameSync(tmp, dest);
  } catch {
    // best-effort — leave whatever prior state exists.
  }
}
