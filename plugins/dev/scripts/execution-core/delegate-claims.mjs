// delegate-claims.mjs — CTL-1744. Delegate-lands claim markers.
//
// WHY THIS EXISTS
// ---------------
// `dispatchTriage`'s CTL-1174 gate (monitor.mjs) is deliberately TWO-PASS:
//
//   pass 1  an undelegated Todo ticket is CLAIMED by delegating it to the
//           orchestrator app-actor, then HELD for this tick;
//   pass 2  triage is dispatched — but only on the next `sweepMissingTriage`,
//           which runs on the reconcile timer (RECONCILE_INTERVAL_MS, 10 min).
//
// So a freshly-claimed ticket is legitimately eligible-but-undispatched for up
// to one reconcile interval. board-health's `dispatchLiveness` invariant could
// not see that wait and read it as a wedged board — on 2026-08-10 a claim two
// minutes old actuated a holistic recovery-pass delegate (opus session, git
// worktree, a concurrency slot) against a completely healthy board, and tripped
// the "unexpected worker" abort condition of a live cutover verification.
//
// These markers are the evidence that lets the invariant grant a BOUNDED grace.
//
// WHY A SEPARATE LEAF MODULE
// --------------------------
// The producer lives in monitor.mjs and the consumer wiring in scheduler.mjs,
// but monitor.mjs already imports scheduler.mjs — so putting the reader in
// monitor.mjs would make scheduler→monitor a CYCLE. This module imports nothing
// but `node:fs`/`node:path` (a zero-import leaf, same discipline as
// secret-contract.mjs), so both sides can depend on it safely.
//
// FAILURE BIAS
// ------------
// Grace SUPPRESSES a recovery signal, so every ambiguous path here is biased
// toward NO GRACE: absent directory, unreadable file, malformed JSON, or a
// non-numeric / non-finite / non-positive timestamp all yield no entry, which
// reproduces the pre-CTL-1744 behavior exactly. This file can never mask a
// genuine wedge — the worst it can do is fail to excuse a legitimate wait.
//
// Placed at orchDir level (not under workers/<t>/) for the same reason as
// .triage-dispatch-counts: the worker-dir GC must not be able to delete it.

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const DELEGATE_CLAIMS_DIR = ".delegate-claims";

export function delegateClaimPath(orchDir, ticket) {
  return join(orchDir, DELEGATE_CLAIMS_DIR, `${ticket}.json`);
}

// recordDelegateClaim — stamp WHEN a ticket was FIRST delegated to the orchestrator.
// Returns true when a marker was written. Never throws: a marker write must
// never break the claim path it is only observing.
//
// FIRST-CLAIM-WINS (CTC review, turn 113). An existing marker is never
// overwritten, so `claimedAt` measures the age of the REAL wait rather than the
// most recent re-claim. Without this the window is RENEWABLE: the pass-1 gate can
// re-run and re-stamp, sliding `claimedAt` forward on every tick, and grace would
// then last as long as the re-claim loop does instead of `graceMs` — suppressing
// dispatch-liveness for exactly the ticket that is genuinely stuck.
//
// Two upstream brakes already make that loop hard to reach — the CTL-1174 latch
// fix live-confirms a cached-null delegate before treating it as undelegated
// (linear-query.mjs), and applyAssignee's read-back is a LIVE query so a write
// that did not stick returns applied:false and never stamps — but the bound must
// be STRUCTURAL, not contingent on two other mechanisms staying correct. A
// flapping delegate, or any future change to either brake, would otherwise
// silently reopen it.
//
// Costs nothing in the happy path: clearDelegateClaim removes the marker when the
// ticket dispatches, so the next legitimate claim writes a fresh timestamp.
export function recordDelegateClaim(orchDir, ticket, { now = () => Date.now() } = {}) {
  // Never manufacture the orch dir itself — a missing one means a hermetic or
  // mocked context (several suites use a shared literal orchDir), and writing
  // there would leak state across runs. Same rule as writeTriageDispatchRecord.
  if (!orchDir || !ticket || !existsSync(orchDir)) return false;
  try {
    const p = delegateClaimPath(orchDir, ticket);
    mkdirSync(dirname(p), { recursive: true });
    // ATOMIC first-claim-wins (MIGRATION turn 115): `wx` = create-exclusive, so
    // the existence check and the write are one syscall. An `existsSync(p)` guard
    // followed by a write would be TOCTOU — two callers could both observe
    // "absent" and the second would slide `claimedAt` forward, reintroducing the
    // renewable window this guard exists to close. EEXIST lands in the catch and
    // returns false, which is the correct outcome: an existing marker (even a
    // malformed one, which grants no grace anyway) is left exactly as it is.
    // Bounding suppression matters more than refreshing an unreadable stamp.
    writeFileSync(p, JSON.stringify({ ticket, claimedAt: now() }), { flag: "wx" });
    return true;
  } catch {
    return false; // existing marker OR write failure ⇒ no NEW window ⇒ bounded
  }
}

// clearDelegateClaim — drop the marker once the ticket actually dispatches.
// NOT load-bearing: a surviving marker expires on its own once
// `now - claimedAt` exceeds the grace window, because the invariant compares
// against wall-clock rather than trusting the file's existence. Housekeeping
// only, so `.delegate-claims/` stays bounded.
export function clearDelegateClaim(orchDir, ticket) {
  if (!orchDir || !ticket) return false;
  try {
    rmSync(delegateClaimPath(orchDir, ticket), { force: true });
    return true;
  } catch {
    return false;
  }
}

// readDelegateClaims — Map<ticket, claimedAtMs> of USABLE evidence only.
export function readDelegateClaims(orchDir) {
  const out = new Map();
  if (!orchDir) return out;
  const dir = join(orchDir, DELEGATE_CLAIMS_DIR);
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return out; // no directory → no evidence → nobody gets grace
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const ticket = name.slice(0, -".json".length);
    if (!ticket) continue;
    try {
      const rec = JSON.parse(readFileSync(join(dir, name), "utf8"));
      const ts = rec?.claimedAt;
      if (typeof ts === "number" && Number.isFinite(ts) && ts > 0) out.set(ticket, ts);
    } catch {
      /* malformed → skip → no grace for this ticket */
    }
  }
  return out;
}
