// cli/beliefs-shadow-status.mjs — CTL-935 Phase 6: flag-live verification helper.
// Computes a shadow-collection health verdict from injected inputs (testable without
// disk or process access).
//
// Verdicts (priority: INACTIVE > NO-DATA > COLLECTION-STALE > CONTIGUITY-VIOLATION > ACTIVE):
//   INACTIVE            — beliefsShadow flag is false
//   NO-DATA             — flag on but zero tick rows (flag-not-set silent failure mode)
//   COLLECTION-STALE    — flag on, ticks exist, newest tick older than STALE_THRESHOLD_MS
//   CONTIGUITY-VIOLATION— flag on, fresh, but max gap between consecutive ticks >= threshold
//   ACTIVE              — collection running normally

import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readGovernanceConfig, readGovernanceSources } from "../config.mjs";

export const STALE_THRESHOLD_MS = 90_000;         // >90s since last tick → stale
export const CONTIGUITY_GAP_THRESHOLD_MS = 1_800_000; // 30-minute gap in tick stream

// ── computeShadowStatus ───────────────────────────────────────────────────────

// computeShadowStatus — pure function, all inputs injected so tests are hermetic.
// Inputs:
//   flagActive:  boolean — effective_flags.beliefsShadow
//   flagSource:  "config" | "env-override" | "default"
//   latestTickMs: number | null — newest tick.now_ms from beliefs.db (null if no rows)
//   tickCount:   number — total tick rows in the query window
//   tickGapMs:   number | null — max consecutive-tick gap in window (null if <2 ticks)
//   nowMs:       number — current epoch ms
//
// Returns: {status, passed, source, sourceWarning, contiguityViolation, ageMs}
export function computeShadowStatus({
  flagActive,
  flagSource = "default",
  latestTickMs = null,
  tickCount = 0,
  tickGapMs = null,
  nowMs = Date.now(),
} = {}) {
  const sourceWarning = flagSource === "env-override";

  if (!flagActive) {
    return { status: "INACTIVE", passed: false, source: flagSource, sourceWarning: false, contiguityViolation: false, ageMs: null };
  }

  if (tickCount === 0 || latestTickMs == null) {
    return { status: "NO-DATA", passed: false, source: flagSource, sourceWarning, contiguityViolation: false, ageMs: null };
  }

  const ageMs = nowMs - latestTickMs;
  if (ageMs > STALE_THRESHOLD_MS) {
    return { status: "COLLECTION-STALE", passed: false, source: flagSource, sourceWarning, contiguityViolation: false, ageMs };
  }

  const contiguityViolation = tickGapMs != null && tickGapMs >= CONTIGUITY_GAP_THRESHOLD_MS;
  if (contiguityViolation) {
    return { status: "CONTIGUITY-VIOLATION", passed: false, source: flagSource, sourceWarning, contiguityViolation: true, ageMs };
  }

  return { status: "ACTIVE", passed: true, source: flagSource, sourceWarning, contiguityViolation: false, ageMs };
}

// ── queryBeliefStats ─────────────────────────────────────────────────────────

// queryBeliefStats — read freshness metrics from beliefs.db.
// Returns {latestTickMs, tickCount, tickGapMs} or null if db unavailable.
export function queryBeliefStats(db) {
  try {
    const row = db.query(
      `SELECT COUNT(*) AS cnt,
              MAX(now_ms) AS latest_ms
         FROM tick`,
    ).get();
    const tickCount = row?.cnt ?? 0;
    const latestTickMs = row?.latest_ms ?? null;

    // Max gap between consecutive ticks (null if <2 ticks).
    let tickGapMs = null;
    if (tickCount >= 2) {
      const gapRow = db.query(
        `SELECT MAX(now_ms - prev_ms) AS max_gap FROM (
           SELECT now_ms,
                  LAG(now_ms) OVER (ORDER BY now_ms) AS prev_ms
             FROM tick
         ) WHERE prev_ms IS NOT NULL`,
      ).get();
      tickGapMs = gapRow?.max_gap ?? null;
    }

    return { latestTickMs, tickCount, tickGapMs };
  } catch {
    return null;
  }
}

// ── renderText ────────────────────────────────────────────────────────────────

export function renderText(result) {
  const lines = [];
  lines.push(`status:  ${result.status}`);
  lines.push(`passed:  ${result.passed}`);
  lines.push(`source:  ${result.source ?? "unknown"}`);
  if (result.sourceWarning) {
    lines.push(`warning: flag set via env-override (not durable config)`);
  }
  if (result.ageMs != null) {
    lines.push(`age:     ${(result.ageMs / 1000).toFixed(1)}s`);
  }
  if (result.contiguityViolation) {
    lines.push(`gap:     contiguity violation (gap >= ${CONTIGUITY_GAP_THRESHOLD_MS / 60_000}min)`);
  }
  return lines.join("\n");
}

// ── main (CLI entry) ──────────────────────────────────────────────────────────

export function main(argv = process.argv.slice(2), { env = process.env, out = console.log } = {}) {
  let dbPath = null;
  let asJson = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--json") asJson = true;
    else if (argv[i] === "--db" && argv[i + 1]) dbPath = argv[++i];
  }

  const governance = readGovernanceConfig(env);
  const sources = readGovernanceSources(env);
  const flagActive = Boolean(governance.beliefsShadow);
  const flagSource = sources.beliefsShadow ?? "default";

  let latestTickMs = null;
  let tickCount = 0;
  let tickGapMs = null;

  if (dbPath && flagActive) {
    try {
      const { Database } = await_require("bun:sqlite");
      const db = new Database(dbPath, { readonly: true, create: false });
      try {
        const stats = queryBeliefStats(db);
        if (stats) { ({ latestTickMs, tickCount, tickGapMs } = stats); }
      } finally {
        try { db.close(); } catch { /* best-effort */ }
      }
    } catch { /* db unavailable — proceed with nulls */ }
  }

  const result = computeShadowStatus({
    flagActive,
    flagSource,
    latestTickMs,
    tickCount,
    tickGapMs,
    nowMs: Date.now(),
  });

  out(asJson ? JSON.stringify(result, null, 2) : renderText(result));
  return result.passed ? 0 : 1;
}

// Synchronous require wrapper for bun:sqlite (not available in ESM static import context).
function await_require(id) {
  // eslint-disable-next-line no-undef
  return typeof require !== "undefined" ? require(id) : (() => { throw new Error(`require not available for ${id}`); })();
}

const isEntry =
  import.meta.main === true ||
  (typeof import.meta.url === "string" &&
    process.argv[1] &&
    fileURLToPath(import.meta.url) === process.argv[1]);

if (isEntry) process.exit(main());
