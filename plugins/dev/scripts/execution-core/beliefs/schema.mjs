// beliefs/schema.mjs — CTL-933 belief-store Step 1: the EDB/IDB SQLite schema.
//
// One table per observation source; every row is an observation AT A TICK —
// never updated, only inserted (retention prunes, nothing mutates). Schema is
// the verbatim spec §1 from
// thoughts/shared/research/2026-06-09-belief-store-step1-datalog.md.
// Substrate: bun:sqlite, hand-written SQL, portable to D1/Postgres by
// construction (AUTOINCREMENT integer pks, TEXT/INTEGER only, no extensions).
//
// NOTE: FOREIGN KEY clauses are declared (documentation + portability) but
// PRAGMA foreign_keys stays OFF — retention pruning is procedural and ordered
// (belief/intent → obs_* → tick), and SQLite's default-off keeps the prune
// resilient to partial historical data.

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

// cfg seed — the spec §1 comment examples. INSERT OR IGNORE on every open, so
// operator-tuned values are never clobbered (tuning is data, not code).
export const CFG_SEED = [
  ["max_parallel", 6],
  ["session_cap", 10],
  ["never_started_ms", 120000],
  ["lease_window_build_ms", 1800000],
  ["lease_window_doc_ms", 2700000],
];

// defaultBeliefsDbPath — CATALYST_BELIEFS_DB wins outright; else
// <catalyst dir>/beliefs.db (CATALYST_DIR, defaulting to ~/catalyst — the same
// resolution family as the event log and catalyst.db).
export function defaultBeliefsDbPath(env = process.env) {
  if (env.CATALYST_BELIEFS_DB) return env.CATALYST_BELIEFS_DB;
  const catalystDir = env.CATALYST_DIR || join(homedir(), "catalyst");
  return join(catalystDir, "beliefs.db");
}

// Spec §1 DDL, column order verbatim. `tenant_id` omitted (single-tenant).
const DDL = [
  // The tick itself is a fact. `now_ms` is captured ONCE per tick; every rule
  // that reasons about time joins against this row (replayability).
  `CREATE TABLE IF NOT EXISTS tick (
    tick_id     INTEGER PRIMARY KEY AUTOINCREMENT,
    now_ms      INTEGER NOT NULL,
    host        TEXT    NOT NULL
  )`,
  // `claude agents --json`, one row per listed agent — including the `state`
  // field ("blocked") the procedural code never read.
  `CREATE TABLE IF NOT EXISTS obs_agent (
    fact_id     INTEGER PRIMARY KEY AUTOINCREMENT,
    tick_id     INTEGER NOT NULL REFERENCES tick(tick_id),
    session_id  TEXT NOT NULL, short_id TEXT NOT NULL,
    kind        TEXT, status TEXT, state TEXT,
    cwd         TEXT, name TEXT, pid INTEGER, started_at_ms INTEGER
  )`,
  // ~/.claude/jobs/<id>/state.json — FULL schema, including tempo/detail/needs.
  `CREATE TABLE IF NOT EXISTS obs_job (
    fact_id     INTEGER PRIMARY KEY AUTOINCREMENT,
    tick_id     INTEGER NOT NULL REFERENCES tick(tick_id),
    bg_job_id   TEXT NOT NULL,
    state       TEXT, tempo TEXT, detail TEXT, needs TEXT,
    first_terminal_at TEXT, cli_version TEXT,
    created_at_ms INTEGER, updated_at_ms INTEGER, mtime_ms INTEGER,
    exists_flag INTEGER NOT NULL DEFAULT 1
  )`,
  // workers/<T>/phase-*.json signal files.
  `CREATE TABLE IF NOT EXISTS obs_signal (
    fact_id     INTEGER PRIMARY KEY AUTOINCREMENT,
    tick_id     INTEGER NOT NULL REFERENCES tick(tick_id),
    ticket      TEXT NOT NULL, phase TEXT NOT NULL,
    status      TEXT, bg_job_id TEXT, generation INTEGER,
    started_at_ms INTEGER, updated_at_ms INTEGER
  )`,
  // Transcript presence/growth — THE turn-zero discriminator.
  `CREATE TABLE IF NOT EXISTS obs_transcript (
    fact_id     INTEGER PRIMARY KEY AUTOINCREMENT,
    tick_id     INTEGER NOT NULL REFERENCES tick(tick_id),
    session_id  TEXT NOT NULL,
    exists_flag INTEGER NOT NULL, mtime_ms INTEGER, bytes INTEGER
  )`,
  // worker.heartbeat events tailed from the event log (append-only; not
  // per-tick, hence no tick_id — pruned by its own ts_ms).
  `CREATE TABLE IF NOT EXISTS obs_heartbeat (
    fact_id     INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket      TEXT NOT NULL, phase TEXT NOT NULL,
    generation  INTEGER, host TEXT, kind TEXT,
    ts_ms       INTEGER NOT NULL
  )`,
  // Linear read-backs (cache-mediated; null state = unreadable this tick).
  `CREATE TABLE IF NOT EXISTS obs_linear (
    fact_id     INTEGER PRIMARY KEY AUTOINCREMENT,
    tick_id     INTEGER NOT NULL REFERENCES tick(tick_id),
    ticket      TEXT NOT NULL, state TEXT
  )`,
  // Static-ish facts the rules need.
  `CREATE TABLE IF NOT EXISTS cfg (key TEXT PRIMARY KEY, value_int INTEGER, value_text TEXT)`,
  // IDB: every derived belief, uniform shape, provenance MANDATORY.
  `CREATE TABLE IF NOT EXISTS belief (
    belief_id   INTEGER PRIMARY KEY AUTOINCREMENT,
    tick_id     INTEGER NOT NULL REFERENCES tick(tick_id),
    stratum     INTEGER NOT NULL,
    name        TEXT NOT NULL,
    subject     TEXT NOT NULL,
    value       TEXT,
    rule_id     TEXT NOT NULL,
    source_fact_ids TEXT NOT NULL,
    UNIQUE (tick_id, name, subject)
  )`,
  // Actions taken because of beliefs — closes the loop.
  `CREATE TABLE IF NOT EXISTS intent (
    intent_id   INTEGER PRIMARY KEY AUTOINCREMENT,
    tick_id     INTEGER NOT NULL, kind TEXT NOT NULL,
    subject     TEXT NOT NULL, belief_id INTEGER REFERENCES belief(belief_id),
    postcondition TEXT, attempts INTEGER DEFAULT 0,
    outcome     TEXT
  )`,
  // Retention-prune indexes (additive to the spec §1 tables; adversarial-review
  // finding 3): pruneRetention's DELETE … WHERE tick_id IN (SELECT … now_ms < ?)
  // would otherwise full-scan every obs_* table at steady state (10⁵–10⁶ rows).
  // belief(tick_id) is already covered by its UNIQUE(tick_id, name, subject).
  `CREATE INDEX IF NOT EXISTS idx_tick_now_ms ON tick (now_ms)`,
  `CREATE INDEX IF NOT EXISTS idx_obs_agent_tick ON obs_agent (tick_id)`,
  `CREATE INDEX IF NOT EXISTS idx_obs_job_tick ON obs_job (tick_id)`,
  `CREATE INDEX IF NOT EXISTS idx_obs_signal_tick ON obs_signal (tick_id)`,
  `CREATE INDEX IF NOT EXISTS idx_obs_transcript_tick ON obs_transcript (tick_id)`,
  `CREATE INDEX IF NOT EXISTS idx_obs_linear_tick ON obs_linear (tick_id)`,
  `CREATE INDEX IF NOT EXISTS idx_obs_heartbeat_ts ON obs_heartbeat (ts_ms)`,
  `CREATE INDEX IF NOT EXISTS idx_intent_tick ON intent (tick_id)`,
];

// openBeliefsDb — open (creating parent dirs) + migrate idempotently + seed
// cfg. Safe to call on every daemon boot and on an existing db: CREATE TABLE
// IF NOT EXISTS + INSERT OR IGNORE means re-open never clobbers data or
// operator-tuned cfg.
export function openBeliefsDb({ path, env = process.env } = {}) {
  const file = path ?? defaultBeliefsDbPath(env);
  try {
    mkdirSync(dirname(file), { recursive: true });
  } catch {
    /* dir exists or uncreatable — Database() below surfaces real failures */
  }
  const db = new Database(file);
  try {
    db.run("PRAGMA journal_mode = WAL");
  } catch {
    /* WAL is an optimization, not a requirement */
  }
  for (const stmt of DDL) db.run(stmt);
  const seed = db.prepare("INSERT OR IGNORE INTO cfg (key, value_int) VALUES (?, ?)");
  for (const [key, valueInt] of CFG_SEED) seed.run(key, valueInt);
  return db;
}
