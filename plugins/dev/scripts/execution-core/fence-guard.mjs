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

// fenceGuard — single decision shared by every external-write site.
//
// Single-host: multiHost:false → always true (no check). Multi-host: reads this
// ticket's claimed generation from its signal file and asks fenceCheckSync if we're
// still the current owner. Missing generation or a stale/failed check → false
// (fail-closed: do NOT perform the side-effect — the write might be a
// post-takeover zombie's).
//
// All three collaborators are injectable for unit tests (no fs or subprocess).
export function fenceGuard(
  { ticket, orchDir, multiHost },
  {
    readGen = () => readSignalGeneration(orchDir, ticket),
    check = fenceCheckSyncCached,
  } = {},
) {
  if (!multiHost) return true; // single-host: always the fence owner
  try {
    const generation = readGen();
    if (!Number.isFinite(generation)) return false; // missing/null/NaN → fail-closed
    return check({ ticket, generation }).current === true;
  } catch {
    return false; // any error → fail-closed
  }
}
