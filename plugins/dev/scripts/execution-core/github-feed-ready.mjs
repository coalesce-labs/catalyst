// github-feed-ready.mjs — CTL-1929. A readiness signal that crosses a PROCESS
// BOUNDARY, because the GitHub leg's producer and its consumer are not in the
// same process and the Linear leg's readiness mechanism therefore does not port.
//
// ── ⛔ WHY THIS FILE EXISTS AT ALL ──────────────────────────────────────────
// On the Linear leg, `setCloudFeedGate` receives `isReady` as a CLOSURE over the
// producer's timer handle (`daemon.mjs:1470`) — legitimate there, because the
// producer (`cloud-feed-timer`) and the consumer (`monitor.mjs`'s tail) both run
// inside `execution-core/daemon.mjs`. One process, one heap, one live answer.
//
// The GitHub leg is NOT shaped like that. Its producer runs in the daemon, but the
// consumer that acts on `github.*` is `broker/tailer.mjs` → `broker/router.mjs`,
// which is a SEPARATE PROCESS (`broker/index.mjs` is its own entry point). A closure
// cannot span it.
//
// ⚠️ AND THE NAIVE MIRROR FAILS SILENTLY IN THE DIRECTION THAT LOOKS FINE. Copying
// the Linear wiring gives the broker `isReady: null`, and `decideDispatch`'s
// "absent probe ⇒ NOT ready" rule then makes smee authoritative for every event,
// forever. No double-dispatch, no error, no alarm — the host logs `mode: enforce`
// and behaves exactly like shadow. The flip would be a LIE, and the way anyone
// would discover it is by eventually retiring the tunnel and losing dispatch.
// A safe fail direction is not the same as a correct one.
//
// ── THE SHAPE ──────────────────────────────────────────────────────────────
// The producer WRITES a small file after each tick with the tick's own verdict;
// the consumer READS it and applies a staleness bound. Readiness is therefore
// "the producer said it was ready, recently enough that the statement is still
// about now" — which is the honest cross-process version of the same question.
//
// ⛔ STALENESS IS NOT OPTIONAL AND IS NOT A DETAIL. A file is a LATCH: if the
// daemon dies mid-enforce, the last thing it wrote was `ready: true`, and without a
// bound the broker would keep suppressing smee on the authority of a process that
// no longer exists — the exact failure the readiness lever is for, made permanent
// by the mechanism meant to prevent it. The bound converts the latch back into a
// heartbeat.
//
// The window is derived from the tick interval rather than fixed: a host running a
// 30 s tick and a host running a 120 s tick do not share a sensible constant, and a
// hard-coded one would either flap on the slow host or latch on the fast one.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * How many missed ticks it takes to call the producer stale.
 *
 * 3, not 1: a single late tick is ordinary (the sweep shares the daemon's event
 * loop, and CTL-1524 is the precedent for a tick that blocks it), and un-arming on
 * one of those would hand dispatch back to smee for a host that is working fine —
 * which is safe but flappy, and flapping across an authority boundary is what
 * CTL-1901 had to correct on the Linear leg. 3 is long enough that a real stall is
 * still caught inside two minutes at the default interval.
 */
export const STALE_TICKS = 3;

/** Absolute floor on the window, for a pathologically small configured interval. */
export const MIN_STALE_MS = 30_000;

export function defaultReadyPath(orchDir, account) {
  return join(orchDir, "shadow", `github-feed-ready-${account}.json`);
}

/**
 * The staleness window for a given tick interval.
 *
 * Exported so the producer and the consumer cannot disagree about it — the one
 * genuinely dangerous bug in a heartbeat is a writer and a reader with different
 * ideas of "recent", which yields either permanent staleness or a latch.
 */
export function staleWindowMs(intervalSec) {
  const sec = Number(intervalSec);
  const base = Number.isFinite(sec) && sec >= 5 ? sec : 30;
  return Math.max(MIN_STALE_MS, base * 1000 * STALE_TICKS);
}

/**
 * writeReadyState — called by the producer once per tick.
 *
 * Record shape (all fields optional on old producers — readers must treat absent
 * as unknown, never as "false" or "off"):
 *   { ready, unready, mode, coverage, source, at, intervalSec }
 *
 * `source` ∈ "env" | "env-invalid" | "layer2" | "default" | null
 *   Distinguishes a deliberately-pinned host (source:"env") from one that fell
 *   through to Layer-2 or the default. Added in CTL-2011 (Phase 1). Absent on
 *   records written by producers predating that change — treat as null.
 *
 * Fail-open on write errors, deliberately: this file is EVIDENCE about the
 * producer, and evidence must never be load-bearing for the thing it observes. A
 * failed write simply ages out, which un-arms enforce — the safe direction.
 */
export function writeReadyState(path, state, { writeFn = writeFileSync, logger = null } = {}) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFn(path, `${JSON.stringify(state)}\n`);
    return true;
  } catch (err) {
    logger?.warn?.({ err: err?.message }, "github-feed: ready-state write failed");
    return false;
  }
}

/**
 * readReadyState — the consumer side. Returns a VERDICT, never a bare boolean, so
 * a suppressed event's capture record can say WHY smee kept authority.
 *
 * Every failure mode resolves to `ready: false` with a distinct reason: absent
 * file (producer never ran / different account), unparseable, missing stamp,
 * stale, or the producer's own `ready: false`.
 */
export function readReadyState(path, { now = Date.now(), intervalSec = 30, readFn = readFileSync } = {}) {
  let raw;
  try {
    raw = readFn(path, "utf8");
  } catch {
    return { ready: false, reason: "ready-file-absent", state: null };
  }
  let state;
  try {
    state = JSON.parse(raw);
  } catch {
    return { ready: false, reason: "ready-file-unparseable", state: null };
  }
  const at = Number(state?.at);
  if (!Number.isFinite(at)) {
    return { ready: false, reason: "ready-file-unstamped", state };
  }
  const age = now - at;
  const window = staleWindowMs(intervalSec);
  // ⚠️ A stamp from the FUTURE is treated as stale, not as fresh. Clock skew or a
  // hand-edited file must not be able to grant indefinite authority — the one
  // direction where "trust the stamp" has no safe reading.
  if (age > window || age < -window) {
    return { ready: false, reason: `ready-file-stale:${Math.round(age / 1000)}s`, state };
  }
  if (state?.ready !== true) {
    return { ready: false, reason: `producer-unready:${state?.unready ?? "unknown"}`, state };
  }
  return { ready: true, reason: "producer-ready", state };
}
