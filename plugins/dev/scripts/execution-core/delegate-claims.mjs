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

// recordDelegateClaim — stamp WHEN a ticket was delegated to the orchestrator.
// Returns true when a marker was written. Never throws: a marker write must
// never break the claim path it is only observing.
export function recordDelegateClaim(orchDir, ticket, { now = () => Date.now() } = {}) {
  // Never manufacture the orch dir itself — a missing one means a hermetic or
  // mocked context (several suites use a shared literal orchDir), and writing
  // there would leak state across runs. Same rule as writeTriageDispatchRecord.
  if (!orchDir || !ticket || !existsSync(orchDir)) return false;
  try {
    const p = delegateClaimPath(orchDir, ticket);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify({ ticket, claimedAt: now() }));
    return true;
  } catch {
    return false; // no marker ⇒ no grace ⇒ prior behavior
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
