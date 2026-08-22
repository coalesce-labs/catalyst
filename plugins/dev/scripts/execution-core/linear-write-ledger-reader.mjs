// linear-write-ledger-reader.mjs — CTL-2027 Phase 2.
//
// The fs-touching half of the Linear write-budget headroom board-health reads.
// `linear-write-headroom.mjs` (the pure evaluator) stays IO-free by design, and
// board-health.mjs itself takes an injected `getXxx()` seam for every external
// read rather than importing `node:fs` directly ("board-health.mjs stays
// fs-free (no fs import)" — see the `hasTriageArtifact` seam comment). This is
// the reader the scheduler wires into that seam, mirroring `readGithubQuota`
// (github-quota-timer.mjs) and `readDelegateClaims` (delegate-claims.mjs).
//
// Rolls to the CURRENT UTC day before returning, mirroring
// `checkLinearWriteBudget`'s own `rollToDay` call. `evaluateLinearWriteHeadroom`
// deliberately treats a not-yet-rolled, stale-day ledger as `unknown` rather
// than rolling it itself (see that module's header) — so the roll has to
// happen on this side of the seam, not inside the pure evaluator.
//
// Fail-open to `null` on any read/parse failure — the same posture
// `readGithubQuota` takes: an absent or corrupt local ledger must never wedge
// the board scan, only leave the published headroom `unknown` downstream.

import { readLedger, rollToDay, utcDayOf } from "./linear-write-budget.mjs";
import { defaultBudgetPath } from "./linear-write-proxy.mjs";

export function readLinearWriteLedgerForBoard(env = process.env, nowMs = Date.now()) {
  const path = defaultBudgetPath(env);
  const r = readLedger(path);
  if (r.state !== "loaded") return null; // absent/unusable → unknown downstream, never a guess
  return rollToDay(r.ledger, utcDayOf(nowMs));
}
