// linear-feed-cursor.mjs — CTL-1847, the durable position of the cloud-feed
// dispatch producer.
//
// ── WHY A CURSOR IS THE SAFETY ARGUMENT, NOT A CONVENIENCE ──────────────────
// `LiveSyncClient` has real gap machinery (`onGapFrame`, `armGapDeadline`,
// `requestResync`, `boundedReseed`). For the replica's EXISTING use — a state
// mirror — a gap is benign: resync converges and the mirror is correct afterwards.
// For a DISPATCH TRIGGER a gap is a ticket that never gets worked, and convergence
// does not re-fire the edge. So "the replica already handles gaps" is the tempting
// wrong answer, and this file is why it isn't ours.
//
// Two properties do the work:
//   1. The cursor is DURABLE, so a restart is not a gap.
//   2. Emission is keyed on `issue_history.id` (a PRIMARY KEY), so a sweep that
//      overlaps already-emitted rows is a no-op rather than a duplicate storm.
//      That is what lets the gap path be a plain reconciling sweep.
//
// ── ⚠️ THE DECISION THIS FILE EXISTS TO MAKE HONEST ─────────────────────────
// ABSENT and UNREADABLE are different verdicts and must not collapse into one
// `null` (the shape this repo has shipped before — see the invalid-treated-as-
// missing pattern). They lead to OPPOSITE actions:
//
//   absent      → first run on this host. Start from now. Nothing was ever emitted,
//                 so there is no history we are obliged to replay.
//   unreadable  → we HAD a position and lost it. Starting from zero would replay
//                 every historical edge (measured: 30,985 rows, 10,011 of them real
//                 state edges) and storm the dispatcher. Starting from now silently
//                 skips whatever happened while we were blind.
//
// We resume from a STATED BOUND — an explicit, configured lookback
// (`resetLookbackMs`) — and never from `Date.now()` bare. The distinction is not
// cosmetic: "now" is an *implicit* boundary that happens to be wherever the clock
// is, so the size of the blind window is unstated and unauditable. A stated bound
// says exactly how much history a reset replays, caps it, and puts the number in
// the alarm.
//
// It also picks the better of the two failure modes. Replaying from zero storms
// the dispatcher with every historical edge and nothing upstream damps it.
// Replaying nothing silently skips whatever happened while we were blind. A
// bounded lookback re-emits only the recent window — and re-emission is cheap
// because dedup is keyed on `issue_history.id`, while anything older degrades to a
// delay rather than a loss, since the daemon's periodic reconcile re-derives
// eligibility on its own tick.
//
// Either way it is REPORTED, because a producer that silently resets its position
// is indistinguishable from one that is working.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Cursor read verdicts. Three-valued on purpose; see the header. */
export const CURSOR_ABSENT = "absent";
export const CURSOR_UNREADABLE = "unreadable";
export const CURSOR_OK = "ok";

export function defaultCursorPath(orchDir) {
  return join(orchDir, "linear-feed-cursor.json");
}

/**
 * Read the durable position.
 *
 * Returns `{ state, position, reason }` where `position` is meaningful only for
 * `CURSOR_OK`. Never throws: the caller is a daemon tick, and a guardrail that can
 * wedge the thing it guards is not a guardrail.
 *
 * Validation is on SHAPE, not merely parseability — `{}` and `null` are valid JSON
 * and tell us nothing. A file that exists but does not carry a usable position is
 * UNREADABLE, not absent: we know a previous run wrote something here.
 */
export function readCursor(path, { readFileFn = readFileSync, existsFn = existsSync } = {}) {
  if (!existsFn(path)) {
    return { state: CURSOR_ABSENT, position: null, reason: "no-cursor-file" };
  }
  let raw;
  try {
    raw = readFileFn(path, "utf8");
  } catch (err) {
    return { state: CURSOR_UNREADABLE, position: null, reason: `read-failed:${err?.code ?? "unknown"}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { state: CURSOR_UNREADABLE, position: null, reason: "malformed-json" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { state: CURSOR_UNREADABLE, position: null, reason: "not-an-object" };
  }
  const at = parsed.lastCreatedAt;
  // Number, integer, non-negative — checked BEFORE any coercion, because
  // Number(null) and Number([]) are both 0, which would read as "the beginning of
  // time" and replay everything.
  if (typeof at !== "number" || !Number.isInteger(at) || at < 0) {
    return { state: CURSOR_UNREADABLE, position: null, reason: "no-usable-position" };
  }
  const lastId = typeof parsed.lastId === "string" && parsed.lastId !== "" ? parsed.lastId : null;
  return { state: CURSOR_OK, position: { lastCreatedAt: at, lastId }, reason: "ok" };
}

/**
 * Persist the position atomically (tmp + rename), so a crash mid-write leaves the
 * previous cursor intact rather than a truncated file that reads as UNREADABLE and
 * costs us the position we were trying to save.
 */
export function writeCursor(path, position, { writeFileFn = writeFileSync, renameFn = renameSync, mkdirFn = mkdirSync } = {}) {
  if (!position || typeof position.lastCreatedAt !== "number" || !Number.isInteger(position.lastCreatedAt)) {
    throw new Error("writeCursor: position.lastCreatedAt must be an integer");
  }
  mkdirFn(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileFn(
    tmp,
    `${JSON.stringify({ lastCreatedAt: position.lastCreatedAt, lastId: position.lastId ?? null })}\n`,
    "utf8",
  );
  renameFn(tmp, path);
}

/**
 * The default stated bound for a reset: how far back a producer that lost its
 * position replays. Modest on purpose — long enough to recover a plausible blind
 * window, short enough that a reset cannot become a historical replay.
 */
export const DEFAULT_RESET_LOOKBACK_MS = 15 * 60 * 1000;

/**
 * Turn a cursor read into the window the sweep should query, and say plainly which
 * of the three situations we are in.
 *
 * ⚠️ `since` is never bare `Date.now()`. On a reset it is `now - resetLookbackMs`,
 * a STATED bound, and the bound is carried on the alarm so the size of the replay
 * is auditable rather than implied by whenever the process happened to restart.
 *
 * `now` is consulted only for the two non-resume cases, so a healthy tick is
 * clock-independent.
 */
export function resolveStartPosition(
  read,
  { now = () => Date.now(), resetLookbackMs = DEFAULT_RESET_LOOKBACK_MS } = {},
) {
  if (read?.state === CURSOR_OK) {
    return { since: read.position.lastCreatedAt, mode: "resume", alarm: null };
  }
  if (read?.state === CURSOR_ABSENT) {
    // First run on this host. Nothing was ever emitted, so there is no backlog we
    // are obliged to replay — but the bound is still stated rather than implicit.
    return { since: now(), lookbackMs: 0, mode: "cold-start", alarm: null };
  }
  const bound = Number.isInteger(resetLookbackMs) && resetLookbackMs >= 0
    ? resetLookbackMs
    : DEFAULT_RESET_LOOKBACK_MS;
  return {
    since: now() - bound,
    lookbackMs: bound,
    mode: "reset",
    // Loud on purpose: a silently-reset producer looks exactly like a working one.
    alarm: {
      severity: "warn",
      reason: read?.reason ?? "unknown",
      lookbackMs: bound,
      message:
        `linear-feed cursor unreadable; resuming from a stated bound of ${bound}ms before now. ` +
        "Edges older than that bound are not replayed — replaying from zero would re-dispatch " +
        "every historical edge — and are recovered by the periodic reconcile instead.",
    },
  };
}
