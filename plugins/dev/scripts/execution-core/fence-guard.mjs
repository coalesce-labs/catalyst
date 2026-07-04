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
//
// ⚠️ HARD SAFETY CAVEAT — projection-first is NEVER safe on an N>1 roster without
// the Stage-1 cross-host reconcile store. A PER-HOST broker projection cannot
// carry a FOREIGN host's takeover generation bump, so a partitioned-but-alive
// zombie keeps heartbeat-re-emitting its OWN fence: its local projection reads
// self-owned + FRESH and the guard would fail OPEN — the exact partitioned-zombie
// write the fence exists to suppress. `claimedAtAgeMs` freshness CANNOT mitigate
// this: the zombie is alive and refreshing its own `claimed_at`, so the row never
// looks stale. Therefore fenceGuard REFUSES CATALYST_FENCE_READ_SOURCE=
// "projection-first" on a multi-host roster unless the Stage-1 capability marker
// (CATALYST_FENCE_STAGE1_STORE) is present, falling back to the authoritative
// "linear" read + a loud warning. Do NOT arm projection-first on >1 hosts until
// Stage 1 (fence-store.mjs + broker cross-host reconcile) is reviewed + merged.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fenceCheckSyncCached } from "./cluster-claim-sync.mjs";
import { gatewayFence, claimedAtAgeMs } from "./gateway-read.mjs";
import { log } from "./config.mjs";

// FENCE_FRESH_MS — how recently a projected fence must have been CLAIMED (or
// re-emitted on the heartbeat cadence) for the multi-host guard to trust the
// local reconciled row instead of escalating to the authoritative read
// (spec §E / OQ-C). It MUST sit comfortably ABOVE the fence re-emit / reconcile
// cadence (LIVENESS_PUBLISH_INTERVAL_MS = 120s). A healthy owner re-emits its
// own fence every 120s, so a freshness window at or below 120s would mark that
// owner's OWN fence stale for the ~30s+ tail of every cycle and needlessly
// escalate to Linear — defeating the quota-relief goal AND risking a fail-closed
// suppression while the breaker/Linear is unavailable even though NO re-emit was
// actually missed (Codex P2, fence-guard.mjs:35). 240s = 2× the 120s re-emit
// interval, so a row is "stale" only after ~2 consecutive missed re-emits (a
// genuinely suspect owner), yet still far below HEARTBEAT_GRACE_MS (10min) — a
// "fresh" fence can never outlive its owner's liveness window. Overridable via
// CATALYST_FENCE_FRESH_MS for tuning.
const FENCE_FRESH_MS_DEFAULT = 240_000;

function resolveFenceFreshMs(env) {
  const raw = Number(env?.CATALYST_FENCE_FRESH_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : FENCE_FRESH_MS_DEFAULT;
}

// stage1CrossHostStoreAvailable — the Stage-1 capability marker. Until the
// cross-host reconcile store (fence-store.mjs + broker cross-host reconcile)
// lands, this is never set, so projection-first is hard-refused on any >1-host
// roster (see the HARD SAFETY CAVEAT at the top of this file). When Stage 1 ships
// and is proven correct, it (and only it) sets CATALYST_FENCE_STAGE1_STORE=1.
function stage1CrossHostStoreAvailable(env) {
  const v = env?.CATALYST_FENCE_STAGE1_STORE;
  return v === "1" || v === "true";
}

// Warn-once-per-ticket dedup for the projection-first refusal on a >1-host roster.
// Keyed by ticket so a misconfiguration surfaces per affected ticket (bounded,
// informative) without spamming the ~5,000/hr guard-call volume every tick.
const _projectionRefuseWarned = new Set();

// readSignalGeneration — read `generation` from the active phase signal file for
// a ticket. Scans workers/<ticket>/phase-*.json, preferring running > newest.
// Returns the numeric generation, or null when absent/unreadable.
//
// ⚠️ DEPRECATED as the fence-guard generation source. This is the per-phase
// single-flight counter (CTL-736), which a fresh dispatch resets to 1 — it is NOT
// the cross-host claim generation the fence attachment compares against. Feeding
// it to fenceGuard suppressed every fenced write on the multi-host fleet. The
// fence path now defaults to readClusterGeneration (below). Retained (exported)
// only for its original single-flight callers; do NOT re-wire it into fenceGuard.
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

// readClusterGeneration — read the CROSS-HOST claim generation from
// workers/<ticket>/cluster-generation.json (persisted once at claim-win by the
// scheduler's writeClusterGeneration, CTL-864). THIS is the counter the Linear
// fence attachment (catalyst://fence/<ticket>) stores and fenceCheckSync compares
// against — NOT the per-phase single-flight `generation` in phase-*.json (CTL-736,
// read by readSignalGeneration), which a fresh dispatch resets to 1. On a
// multi-host fleet the two counters are unrelated and essentially never match, so
// feeding the phase counter to the fence check suppressed EVERY fenced write
// forever (the terminal Done write never landed → the board froze; ~1,090/hr
// `stale fence` WARN on CTL-1423). Returns the numeric generation, or null when
// absent/unreadable (→ the ticket_state fallback in fenceGuard, else fail-closed).
export function readClusterGeneration(orchDir, ticket, { readFile = readFileSync } = {}) {
  if (!orchDir || !ticket) return null;
  try {
    const raw = readFile(join(orchDir, "workers", ticket, "cluster-generation.json"), "utf8");
    const g = JSON.parse(raw);
    return Number.isFinite(g?.generation) ? g.generation : null;
  } catch {
    return null;
  }
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
//     be the fleet default. GUARDRAIL: on a multi-host roster this mode is
//     HARD-REFUSED (falls back to "linear" + a loud warning) unless the Stage-1
//     capability marker CATALYST_FENCE_STAGE1_STORE is set, so an operator cannot
//     arm the unsafe fast path before Stage 1 exists.
//
// FAIL-CLOSED for the mutating write sites: a missing generation or any thrown
// error → false (suppress the side-effect). ESCALATION write sites pass
// proceedOnMissingGeneration:true to fail OPEN (log loud + write) on a missing
// generation, so a needs-human escalation is never silently dropped. All
// collaborators are injectable for unit tests.
export function fenceGuard(
  { ticket, orchDir, multiHost, gateway, self },
  {
    readGen = () => readClusterGeneration(orchDir, ticket),
    readFence = (t) => gatewayFence(gateway, t),
    isFresh = (f, env = process.env) => claimedAtAgeMs(f) < resolveFenceFreshMs(env),
    escalate = fenceCheckSyncCached,
    readSource = process.env.CATALYST_FENCE_READ_SOURCE || "linear",
    env = process.env,
    logger = log,
    // WATCH-ITEM (Codex): an ESCALATION write site (e.g. stale-pr-rescue's
    // needs-human labelOnce) passes this true so a MISSING generation fails OPEN
    // — log loud + proceed with the prior always-write behavior — rather than
    // silently dropping a human escalation. The mutating write sites keep the
    // default (false = fail-closed): suppressing a mutating write on "can't tell"
    // is the safe side; dropping a needs-human escalation is NOT.
    proceedOnMissingGeneration = false,
  } = {},
) {
  // N=1 single-host gate: provably no peer → trust local unconditionally.
  if (!multiHost) return true;

  // ── N>1 SAFETY GUARDRAIL (spec §C2 / HARD SAFETY CAVEAT at top) ────────────
  // projection-first is UNSAFE on a multi-host roster until the Stage-1
  // cross-host reconcile store exists — a per-host projection cannot carry a
  // foreign host's takeover bump, so a partitioned-but-alive zombie re-emits its
  // own fresh fence and reads self-owned+fresh → fails OPEN. Refuse it, fall back
  // to the authoritative "linear" read, and warn loudly (once per ticket).
  let effectiveReadSource = readSource;
  if (readSource === "projection-first" && !stage1CrossHostStoreAvailable(env)) {
    if (!_projectionRefuseWarned.has(ticket)) {
      _projectionRefuseWarned.add(ticket);
      logger?.warn?.(
        { ticket, self },
        "ctl-863: REFUSING CATALYST_FENCE_READ_SOURCE=projection-first on a >1-host roster " +
          "WITHOUT the Stage-1 cross-host reconcile store (CATALYST_FENCE_STAGE1_STORE) — " +
          "projection-first can fail OPEN for a partitioned zombie; freshness cannot mitigate it. " +
          "Falling back to the authoritative 'linear' read.",
      );
    }
    effectiveReadSource = "linear";
  }

  try {
    let generation = readGen();
    // Fallback: when cluster-generation.json is absent (e.g. a ticket claimed
    // while the roster was single-host and only later grew, or a pruned worker-dir
    // mirror), recover the cross-host claim generation from the ticket_state
    // projection (catalyst_generation) via the gateway — but ONLY when the
    // projection agrees WE (self) are the owner (f.ownerHost === self). This
    // mirrors the ownership guard the projection-first branch already applies
    // (f.ownerHost !== self → suppress). Borrowing the projection's CURRENT
    // generation for a FOREIGN owner would be a fail-OPEN: escalate() checks only
    // "is this generation current?" (NOT ownership), so a partitioned zombie whose
    // local file is gone would read the new owner's current generation, hand it to
    // escalate(), get a tautological match, and be allowed to write — the exact
    // corruption this fence exists to prevent (cf. scheduler.mjs readClusterGeneration:
    // "reading the current generation would always match and silently defeat the
    // fence"). With the self-owner guard the seeded generation is still validated by
    // the authoritative escalate() below — a LIVE Linear read, not the projection —
    // so a self-owned-but-STALE row still fails closed. A foreign/unowned/absent row
    // seeds nothing → fail-closed for mutating sites (fail-open only where the site
    // opted into proceedOnMissingGeneration).
    if (!Number.isFinite(generation) && gateway) {
      try {
        const f = readFence(ticket);
        if (Number.isFinite(f?.generation) && f.ownerHost === self) {
          generation = f.generation;
        }
      } catch (err) {
        // A throwing gateway/SQLite read is a real (rare) fault, not the common
        // "no row" case — surface it at debug so a silent fence suppression here is
        // diagnosable, then fall through to the missing-generation handling.
        logger?.debug?.({ ticket, err: err?.message }, "fenceGuard: ticket_state fallback read threw");
      }
    }
    if (!Number.isFinite(generation)) {
      if (proceedOnMissingGeneration) {
        // Loud fail-open: never silently drop an escalation on "can't tell".
        logger?.warn?.(
          { ticket },
          "ctl-863: fenceGuard read NO generation for this ticket — PROCEEDING with the " +
            "guarded write (fail-open) rather than silently dropping it (escalation site).",
        );
        return true;
      }
      return false; // missing/null/NaN → fail-closed (mutating write sites)
    }

    // Stage 1 opt-in: trust a FRESH cross-host-reconciled projection row.
    // (effectiveReadSource is only ever "projection-first" here once the Stage-1
    // marker is present — the guardrail above forces "linear" otherwise.)
    if (effectiveReadSource === "projection-first" && gateway) {
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
