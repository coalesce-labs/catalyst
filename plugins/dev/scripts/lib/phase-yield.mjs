// phase-yield.mjs — the "yielded, resumable" phase state. CTL-1854, option 3.
//
// ── THE DEFECT ──────────────────────────────────────────────────────────────
// A phase agent delegates to a background job, says "I'll be re-invoked when it
// completes", and ends its turn. The runner has no such contract: the turn ends,
// the SDK session ends cleanly (subtype "success"), the signal is never declared,
// and sdk-run-phase-agent writes status:"failed", outcome:"abandoned",
// failureReason:"ended-without-declaration". The work was DONE; a human is paged.
//
// MEASURED 2026-08-14: 5 such events across both hosts in one day, all in
// `implement` and `monitor-merge` — exactly the phases with a reason to await
// background work. Turn counts 11-15 of 500, context 8%, SDK subtype "success".
// Two of the fleet's dead sessions (CTL-1805, CTL-1841) are this, and CTL-1841 is
// the ingestion-silence alarm — the defect ate the fix for another defect.
//
// ── WHY A NEW STATE, AND NOT needs-input ────────────────────────────────────
// `needs-input` is already a parked status the abandon-flip respects, so it would
// "work". It is wrong: needs-input means WAITING ON A HUMAN — CTL-768's
// comment-wake clears it and the disposition label pages someone. An agent waiting
// on its own background job needs nobody, and labelling it needs-input is a FALSE
// PAGE, which is the CTL-1850 defect this fix must not import.
//
// ── ⚠️ THE CONSTRAINT THAT MAKES THIS SAFE: A YIELD MUST EXPIRE ─────────────
// `isTicketInFlight` (scheduler.mjs) returns FALSE only for `failed|stalled|
// aborted` (plus a terminal-phase `done|skipped`). ANY other status — including a
// new one — keeps the slot held. So an unbounded yielded state recreates exactly
// the stranding the abandon-flip exists to prevent; sdk-run-phase-agent's own
// comment names it: "isTicketInFlight stays true, classifyWorker returns 'unknown'
// so the CTL-574 reclaim never fires, and the terminal sweep never escalates — a
// stranded, invisible ticket".
//
// So a yield is a DEADLINE, not a permit. Past it the runner writes the same
// terminal it writes today, with a failureReason that says which promise was
// broken. The state converts a silent abandonment into an explicit, bounded wait;
// it never removes the backstop.
//
// Default ceiling is 30 minutes because that is Linear's agent-session stale
// deadline (>30 min with no activity → `stale`). A yield outliving the session it
// is meant to keep alive buys nothing.
//
// Zero-import leaf, like event-name.mjs / event-envelope.mjs: bare-Node loadable,
// pure, and callable from the runner, the scheduler and tests alike.

// ── ⚠️ NAME COLLISION, READ BEFORE GREPPING ─────────────────────────────────
// "Yield" already means something ELSE one directory over. CTL-615's
// duplicate-worker gate (phase-agent-yield-check.sh, and the
// `phase-*-yield-*.json` tombstones CTL-702's sweep scans in scheduler.mjs) is a
// redispatch DUPLICATE bowing out to the canonical worker — a worker yielding to
// another worker. This module is a worker yielding to its own BACKGROUND WORK
// and expecting to be resumed. Same word, unrelated mechanisms, and a grep for
// "yield" in exec-core returns both.
//
// ── WHERE A YIELD EXPIRES ───────────────────────────────────────────────────
// NOT here, and NOT in the runner. `shouldFlipOnUndeclaredExit` is called by
// sdk-run-phase-agent as the worker exits — microseconds after `yieldedAt` was
// written, when a yield is ALWAYS live — so that call site can never observe a
// deadline pass. The enforcing evaluator is `reclaimDeadWorkIfPossible`
// (recovery.mjs), which schedulerTick runs once per signal per tick. If you add
// a new caller of this module, assume it is an observer; the tick owns expiry.

/** The status an agent writes to declare a bounded, resumable wait. */
export const YIELDED_STATUS = "awaiting-work";

/** Ceiling on a single yield. Matches Linear's 30-minute session-stale deadline. */
export const MAX_YIELD_MS = 30 * 60 * 1000;

/** failureReason written when a yield outlives its deadline. */
export const YIELD_EXPIRED_REASON = "yield-expired";

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function parseMs(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v !== "") {
    const t = Date.parse(v);
    if (Number.isFinite(t)) return t;
  }
  return null;
}

/**
 * Classify a phase signal's yield state.
 *
 * @returns {{yielded: boolean, expired: boolean, reason: string, deadlineMs: number|null}}
 *
 * `reason` is always populated so a caller can report WHY it decided, rather than
 * reporting a bare false that is indistinguishable from "could not tell".
 */
export function classifyYield(sig, nowMs = Date.now(), maxYieldMs = MAX_YIELD_MS) {
  if (!isPlainObject(sig)) return { yielded: false, expired: false, reason: "not-a-signal", deadlineMs: null };
  if (String(sig.status) !== YIELDED_STATUS) {
    return { yielded: false, expired: false, reason: "not-yielded", deadlineMs: null };
  }

  // A yield without a readable start is treated as EXPIRED, not as an open-ended
  // permit. The fail direction is deliberate: an unreadable deadline must not buy
  // an unbounded hold, because that is the stranding this state is designed to
  // avoid. Losing a legitimate wait costs one re-dispatch; losing the bound costs
  // a slot forever.
  const startedMs = parseMs(sig.yieldedAt);
  if (startedMs === null) {
    return { yielded: true, expired: true, reason: "yield-start-unreadable", deadlineMs: null };
  }

  // ⚠️ THE CEILING BOUNDS THE EPISODE, NOT THE INDIVIDUAL YIELD.
  // `yieldedAt` is rewritten on every yield declaration, so an agent that
  // re-yields before its deadline would earn a fresh window each time and hold
  // the slot forever by repetition — the exact unbounded hold this state exists
  // to prevent, reachable in a loop instead of in one write. `firstYieldedAt` is
  // set once per episode and preserved across re-yields, so the total wait can
  // never exceed the ceiling however many times an agent asks. A signal without
  // it (written before this shipped, or by a single yield) anchors on
  // `yieldedAt`, which is the same instant — so the bound is unchanged there.
  // ABSENT anchors on this yield; PRESENT-BUT-UNREADABLE expires. Collapsing the
  // two would let a corrupt anchor buy the fresh window the anchor exists to deny.
  const hasEpisodeAnchor = sig.firstYieldedAt !== undefined && sig.firstYieldedAt !== null;
  const episodeStartMs = hasEpisodeAnchor ? parseMs(sig.firstYieldedAt) : startedMs;
  if (episodeStartMs === null) {
    return { yielded: true, expired: true, reason: "episode-start-unreadable", deadlineMs: null };
  }

  // An agent may request less than the ceiling; it may never request more.
  const requested = typeof sig.yieldMs === "number" && Number.isFinite(sig.yieldMs) && sig.yieldMs > 0
    ? Math.min(sig.yieldMs, maxYieldMs)
    : maxYieldMs;
  const deadlineMs = Math.min(episodeStartMs + maxYieldMs, startedMs + requested);

  if (!Number.isFinite(nowMs)) {
    // A caller that cannot tell the time cannot extend a deadline either.
    return { yielded: true, expired: true, reason: "now-unreadable", deadlineMs };
  }
  return nowMs > deadlineMs
    ? { yielded: true, expired: true, reason: "deadline-passed", deadlineMs }
    : { yielded: true, expired: false, reason: "within-deadline", deadlineMs };
}

/**
 * Should the undeclared-exit flip write a terminal for this signal?
 *
 * TRUE  → proceed exactly as today (abandoned / ended-without-declaration, or
 *         yield-expired when a yield ran out).
 * FALSE → the agent declared a live, unexpired yield; leave the signal alone.
 */
export function shouldFlipOnUndeclaredExit(sig, nowMs = Date.now(), maxYieldMs = MAX_YIELD_MS) {
  const y = classifyYield(sig, nowMs, maxYieldMs);
  if (!y.yielded) return { flip: true, failureReason: null, yield: y };
  if (y.expired) return { flip: true, failureReason: YIELD_EXPIRED_REASON, yield: y };
  return { flip: false, failureReason: null, yield: y };
}
