// belief-store-queries.mjs — pure, db-injected query functions for the
// GET /api/beliefs/{summary,rates,recent,cfg} read endpoints (CTL-1100 Phase 3).
// All SQL lives here (single source); callers inject the db handle and get
// plain JS values back. No bun:sqlite static import — callers open/close via
// governance-reader.mjs:withBeliefsDbRO.
//
// RULE_MANIFEST is served by a computed-import re-export so the /rules route
// never needs a db handle. DO NOT change the specifier to a string literal
// (VITE-GRAPH GUARD — see governance-reader.mjs header).

// beliefRulesManifest — serve RULE_MANIFEST verbatim via computed import.
// Returns the frozen manifest or null on import failure (404 the route).
// NOTE: DO NOT inline the specifier — computed specifier required (CTL-883).
export async function beliefRulesManifest() {
  try {
    const rulesMod = ["../../execution-core/beliefs/rules.mjs"].join("");
    const mod = await import(rulesMod);
    return mod.RULE_MANIFEST ?? null;
  } catch {
    return null;
  }
}

// beliefSummary — COUNT(DISTINCT subject) + COUNT(*) per name at the LATEST tick.
// Rows sorted by name. Returns {tickId:null,rows:[]} on empty belief table.
export function beliefSummary(db) {
  try {
    const maxRow = db.query("SELECT MAX(tick_id) AS max_id FROM belief").get();
    const tickId = maxRow?.max_id ?? null;
    if (tickId == null) return { tickId: null, rows: [] };
    const rows = db.query(
      `SELECT name,
              COUNT(DISTINCT subject) AS subjects,
              COUNT(*) AS total
         FROM belief
        WHERE tick_id = ?
        GROUP BY name
        ORDER BY name`
    ).all(tickId);
    return { tickId, rows };
  } catch {
    return { tickId: null, rows: [] };
  }
}

// Constants exposed for tests.
export const RECENT_DEFAULT_LIMIT = 50;
export const RECENT_MAX_LIMIT = 500;
export const RATES_LRU_CAP = 64;

// beliefRatesRaw — compute full GROUP BY tick_id, rule_id rates over idx_belief_rule_id.
// Returns {maxTick, rows} or {maxTick:null, rows:[]}.
// NOTE: idx_belief_rule_id already exists (schema.mjs:170, CTL-1063 Phase 4) — no migration.
function beliefRatesRaw(db) {
  try {
    const maxRow = db.query("SELECT MAX(tick_id) AS max_id FROM belief").get();
    const maxTick = maxRow?.max_id ?? null;
    if (maxTick == null) return { maxTick: null, rows: [] };
    const rows = db.query(
      `SELECT tick_id, rule_id, COUNT(*) AS count
         FROM belief
        GROUP BY tick_id, rule_id
        ORDER BY tick_id, rule_id`
    ).all();
    return { maxTick, rows };
  } catch {
    return { maxTick: null, rows: [] };
  }
}

// beliefRates — return cached result if maxTick unchanged; else recompute.
// Evicts oldest entry when size exceeds RATES_LRU_CAP.
export function beliefRates(db, lru) {
  try {
    const maxRow = db.query("SELECT MAX(tick_id) AS max_id FROM belief").get();
    const maxTick = maxRow?.max_id ?? null;
    if (lru.has(maxTick)) return lru.get(maxTick);
    const result = beliefRatesRaw(db);
    lru.set(maxTick, result);
    // Evict oldest entries when over cap.
    if (lru.size > RATES_LRU_CAP) {
      const oldest = lru.keys().next().value;
      lru.delete(oldest);
    }
    return result;
  } catch {
    return { maxTick: null, rows: [] };
  }
}

// beliefRecent — return the last N beliefs newest-first, joined with tick.now_ms and tick.host.
// Cap enforced at RECENT_MAX_LIMIT. Missing rules_sha column degrades to null.
export function beliefRecent(db, { limit = RECENT_DEFAULT_LIMIT } = {}) {
  try {
    const safeLimit = Math.min(Math.max(1, limit), RECENT_MAX_LIMIT);
    // Check if rules_sha column exists (same probe as belief-reader.mjs).
    let tickCols;
    try {
      const cols = db.query("PRAGMA table_info(tick)").all();
      const hasRulesSha = cols.some((c) => c.name === "rules_sha");
      tickCols = hasRulesSha ? "t.now_ms AS ts_ms, t.host, t.rules_sha" : "t.now_ms AS ts_ms, t.host, NULL AS rules_sha";
    } catch {
      tickCols = "t.now_ms AS ts_ms, t.host, NULL AS rules_sha";
    }
    const rows = db.query(
      `SELECT b.belief_id, b.tick_id, b.rule_id, b.name, b.subject, b.value,
              b.source_fact_ids, b.stratum, ${tickCols}
         FROM belief b
         LEFT JOIN tick t ON t.tick_id = b.tick_id
        ORDER BY b.belief_id DESC
        LIMIT ?`
    ).all(safeLimit);
    return { rows };
  } catch {
    return { rows: [] };
  }
}

// beliefCfg — return all cfg rows ordered by key.
export function beliefCfg(db) {
  try {
    const rows = db.query("SELECT key, value_int, value_text FROM cfg ORDER BY key").all();
    return { rows };
  } catch {
    return { rows: [] };
  }
}
