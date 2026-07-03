// fence-guard.mjs — shared stale-generation guard for external-write sites (CTL-863 Phase 4).
//
// fenceGuard is called BEFORE each of the 10 daemon-side external-write sites
// (Linear/GitHub writes). On a ≥2-host cluster, a paused/partitioned zombie that
// wakes up after another host took over should NOT be allowed to corrupt Linear
// state. The guard reads this ticket's claimed generation from its signal file and
// asks fenceCheckSyncCached if we're still the current owner. FAIL-CLOSED: any
// failure (missing signal, spawn error, stale gen) returns false → suppress the write.
//
// SINGLE-HOST is a guaranteed no-op: multiHost:false → return true without calling
// check. This is the common case (most installs are single-host), so the guard
// adds zero cost in the steady state.
//
// fenceCheckSyncCached (not the raw fenceCheckSync) is the default `check` — an
// in-process TTL cache (default 45s, CATALYST_FENCE_READ_CACHE_MS) around the
// underlying `query ReadFence` read, added as an URGENT interim fix: on a
// multi-host cluster this guard's own read volume (~5,000/hr across all sites)
// was saturating the shared Linear app-actor bucket and freezing dispatch via
// the CTL-679 breaker. See cluster-claim-sync.mjs for the full rationale; the
// cache changes read volume only, never fenceGuard's fail-closed decision.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fenceCheckSyncCached } from "./cluster-claim-sync.mjs";
import { gatewayFence, claimedAtAgeMs } from "./gateway-read.mjs";

// FENCE_FRESH_MS — how recently a projected fence must have been CLAIMED (or
// re-emitted on the heartbeat cadence) for the multi-host guard to trust the
// local reconciled row instead of escalating to the authoritative read
// (spec §E / OQ-C). 90s = 3× the 30s tick and < the 120s fence re-emit /
// reconcile cadence (LIVENESS_PUBLISH_INTERVAL_MS): a row that missed exactly
// one re-emit is already suspect and escalates rather than being trusted. It is
// far below HEARTBEAT_GRACE_MS (10min), so a "fresh" fence can never outlive its
// owner's liveness window. Overridable via CATALYST_FENCE_FRESH_MS for tuning.
const FENCE_FRESH_MS_DEFAULT = 90_000;

function resolveFenceFreshMs(env) {
  const raw = Number(env?.CATALYST_FENCE_FRESH_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : FENCE_FRESH_MS_DEFAULT;
}

// readSignalGeneration — read `generation` from the active phase signal file for
// a ticket. Scans workers/<ticket>/phase-*.json, preferring running > newest.
// Returns the numeric generation, or null when absent/unreadable.
export function readSignalGeneration(orchDir, ticket, { readDir = readdirSync, readFile = readFileSync } = {}) {
  if (!orchDir || !ticket) return null;
  const dir = join(orchDir, "workers", ticket);
  let files;
  try {
    files = readDir(dir).filter((f) => f.startsWith("phase-") && f.endsWith(".json"));
  } catch {
    return null;
  }
  let best = null;
  let bestRank = -1;
  for (const f of files) {
    let sig;
    try {
      sig = JSON.parse(readFile(join(dir, f), "utf8"));
    } catch {
      continue;
    }
    if (!Number.isFinite(sig?.generation)) continue;
    const running = sig.status === "running" ? 1 : 0;
    const ts = Date.parse(sig.updatedAt ?? sig.startedAt ?? "") || 0;
    const rank = running * 1e15 + ts;
    if (rank > bestRank) {
      bestRank = rank;
      best = sig.generation;
    }
  }
  return best;
}

// fenceGuard — single decision shared by every external-write site (CTL-863
// durable fence → event-log migration; supersedes the #2552 interim ReadFence
// cache on the read path).
//
// ── N=1 SINGLE-HOST GATE (spec §C1) ──────────────────────────────────────────
// multiHost:false means the LIVE roster has exactly one host → NO peer can ever
// supersede this fence → the local fast path is UNCONDITIONALLY correct. Return
// true with no read at all (today's exact behavior, the safe floor). Single-host
// is the common case and pays zero cost.
//
// ── MULTI-HOST (spec §C2/§D) ─────────────────────────────────────────────────
// A ≥2-host roster can be superseded by a peer's takeover, so we must NOT
// silently trust local state. The read source is selected by
// CATALYST_FENCE_READ_SOURCE:
//
//   "linear" (DEFAULT, Stage 0) — escalate to the authoritative read
//     (fenceCheckSyncCached: the #2552 interim cache over `query ReadFence`).
//     This is today's exact behavior. The projection-first fast path is NOT
//     armed for multi-host because a PER-HOST broker projection cannot carry a
//     FOREIGN host's takeover bump (spec's fatal finding 1) — trusting it would
//     fail OPEN for the exact partitioned-zombie case the fence exists to catch.
//     Arming it safely requires the cross-host reconcile store (spec Stage 1),
//     which is a separate, fleet-reviewed change.
//
//   "projection-first" (Stage 1, opt-in) — read the broker projection; trust a
//     FRESH self-owned + generation-matching row (claimed_at-age < FENCE_FRESH_MS);
//     a fresh row showing a foreign owner (incl. a released→null owner) or a higher
//     generation → suppress; a stale/absent row → escalate to the authoritative
//     read (migration-safe fallback, no fence gap). ONLY safe once the broker
//     reconciles foreign fence rows cross-host (Stage 1) — until then it MUST NOT
//     be the fleet default.
//
// FAIL-CLOSED throughout: a missing generation or any thrown error → false
// (suppress the side-effect). All collaborators are injectable for unit tests.
export function fenceGuard(
  { ticket, orchDir, multiHost, gateway, self },
  {
    readGen = () => readSignalGeneration(orchDir, ticket),
    readFence = (t) => gatewayFence(gateway, t),
    isFresh = (f, env = process.env) => claimedAtAgeMs(f) < resolveFenceFreshMs(env),
    escalate = fenceCheckSyncCached,
    readSource = process.env.CATALYST_FENCE_READ_SOURCE || "linear",
    env = process.env,
  } = {},
) {
  // N=1 single-host gate: provably no peer → trust local unconditionally.
  if (!multiHost) return true;

  try {
    const generation = readGen();
    if (!Number.isFinite(generation)) return false; // missing/null/NaN → fail-closed

    // Stage 1 opt-in: trust a FRESH cross-host-reconciled projection row.
    if (readSource === "projection-first" && gateway) {
      const f = readFence(ticket);
      if (f && isFresh(f, env)) {
        if (f.ownerHost !== self) return false; // foreign owner (incl. released→null) → suppress
        return f.generation === generation; // higher/other gen → suppress
      }
      // stale/absent projection → fall through to the authoritative read.
    }

    // Stage 0 default (and Stage 1 stale/absent fallback): authoritative read.
    return escalate({ ticket, generation }).current === true;
  } catch {
    return false; // any error → fail-closed
  }
}
