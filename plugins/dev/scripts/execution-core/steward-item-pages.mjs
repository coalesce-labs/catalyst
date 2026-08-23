// steward-item-pages.mjs — CTL-2129 Phase 3. A durable, per-ITEM page counter so
// Scenario 2 ("the steward missed two cycles on the SAME item") becomes
// `priorPages >= STEWARD_TURNS_BEFORE_CONCIERGE` in the escalation router.
//
// It increments each time the steward is paged on a scope, and reads back as 0
// once the steward has taken a turn since the last page. Keyed by the SCOPE KEY
// (Linear project id) so two tickets that both stall in one project accrue toward
// the SAME steward's turns — a steward that ignored project P twice escalates to
// the concierge whether the two silences were on one ticket or two.
//
// Pattern-twin of quiet-fleet's latch, but keyed by item and stored under the
// ORCHESTRATOR dir (survives ticket completion — a merged ticket's worker dir is
// torn down, but the project's page history must not reset with it). Deliberately
// NOT extracted into a shared latch module: different key space, different dir.
//
// node:*-only, fail-open end to end: an unreadable/corrupt marker reads as 0 and
// never throws, so a bookkeeping glitch can never crash the escalation path.
import { readFileSync, writeFileSync, renameSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const PAGES_DIR = ".steward-pages";

// safeKey — a scope key is a Linear project id (uuid) or a ticket id, but never
// trust it: sanitize anything that is not [A-Za-z0-9._-] to `_` so the key can
// never escape PAGES_DIR (a `/` or `..` in a key must not write outside it).
function safeKey(key) {
  return String(key ?? "").replace(/[^A-Za-z0-9._-]/g, "_") || "_";
}

function markerPath(orchDir, key) {
  return join(orchDir, PAGES_DIR, `${safeKey(key)}.json`);
}

function readMarker(orchDir, key) {
  try {
    return JSON.parse(readFileSync(markerPath(orchDir, key), "utf8"));
  } catch {
    return null; // missing OR corrupt → no history (reads as 0)
  }
}

function writeMarkerAtomic(orchDir, key, obj) {
  const p = markerPath(orchDir, key);
  mkdirSync(join(orchDir, PAGES_DIR), { recursive: true });
  const tmp = `${p}.tmp.${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`);
  renameSync(tmp, p);
}

/**
 * How many times the steward has been paged on `key` WITHOUT taking a turn since.
 *
 * `stewardTookTurn(key, lastPagedAtMs)` is INJECTED (Phase 4 wires the default:
 * the resolved steward's heartbeat `last_turn_ts` advanced past `last_paged_at`).
 * A turn since the last page clears the count to 0 — the steward is engaged, so
 * the ladder must not escalate inward to the concierge on stale pages.
 *
 * @param {string} orchDir
 * @param {string} key  the scope key (project id)
 * @param {{stewardTookTurn?: (key: string, lastPagedAtMs: number|undefined) => boolean}} [deps]
 * @returns {number}
 */
export function readItemPages(orchDir, key, { stewardTookTurn = () => false } = {}) {
  const m = readMarker(orchDir, key);
  if (!m) return 0;
  try {
    if (stewardTookTurn(key, m.last_paged_at)) return 0;
  } catch {
    // A throwing predicate must not crash the read — treat as "no turn" and use
    // the stored count (the fail direction that keeps escalating, never loses a page).
  }
  return Number.isInteger(m.count) ? m.count : 0;
}

/**
 * Record one page on `key`: increment count, stamp first/last_paged_at. Atomic
 * (tmp+rename). Fail-open — a failed write returns the best-effort next count and
 * never throws out of the escalation path.
 *
 * @returns {number} the new count (1 on the first page)
 */
export function recordItemPage(orchDir, key, { now = Date.now() } = {}) {
  const prior = readMarker(orchDir, key);
  const priorCount = Number.isInteger(prior?.count) ? prior.count : 0;
  const next = {
    key: String(key ?? ""),
    count: priorCount + 1,
    first_paged_at: prior?.first_paged_at ?? now,
    last_paged_at: now,
  };
  try {
    writeMarkerAtomic(orchDir, key, next);
  } catch {
    /* best-effort — the count is advisory bookkeeping, never load-bearing */
  }
  return next.count;
}

/** Best-effort reset (a steward turn / item resolved). Never throws. */
export function resetItemPages(orchDir, key) {
  try {
    rmSync(markerPath(orchDir, key));
    return true;
  } catch {
    return false;
  }
}
