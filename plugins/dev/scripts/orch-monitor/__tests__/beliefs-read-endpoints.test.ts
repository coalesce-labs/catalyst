// CTL-1100 Phase 3: GET /api/beliefs/rules|summary|rates|recent|cfg
// Pure unit tests for query functions + HTTP integration tests.

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createServer } from "../server";

// Load query fns via computed specifier for isolation.
const queryMod = await import("../lib/belief-store-queries.mjs");
const {
  beliefSummary,
  beliefRates,
  beliefRecent,
  beliefCfg,
  RECENT_DEFAULT_LIMIT,
  RATES_LRU_CAP,
} = queryMod as {
  beliefSummary: (db: Database) => unknown;
  beliefRates: (db: Database, lru: Map<number | null, unknown>) => unknown;
  beliefRecent: (db: Database, opts?: { limit?: number }) => unknown;
  beliefCfg: (db: Database) => unknown;
  RECENT_DEFAULT_LIMIT: number;
  RATES_LRU_CAP: number;
};

// Load RULE_MANIFEST via computed specifier (no static bun:sqlite chain).
const rulesMod = await import("../../execution-core/beliefs/rules.mjs");
const { RULE_MANIFEST } = rulesMod as { RULE_MANIFEST: { strata: unknown[]; rules: Array<{ rule_id: string; name: string }> } };

// ─── helpers ────────────────────────────────────────────────────────────────

function makeDb(): Database {
  const db = new Database(":memory:");
  db.run(`CREATE TABLE tick (
    tick_id INTEGER PRIMARY KEY AUTOINCREMENT,
    now_ms  INTEGER NOT NULL,
    host    TEXT    NOT NULL,
    rules_sha TEXT
  )`);
  db.run(`CREATE TABLE belief (
    belief_id INTEGER PRIMARY KEY AUTOINCREMENT,
    tick_id   INTEGER NOT NULL,
    stratum   INTEGER NOT NULL,
    name      TEXT NOT NULL,
    subject   TEXT NOT NULL,
    value     TEXT,
    rule_id   TEXT NOT NULL,
    source_fact_ids TEXT NOT NULL,
    UNIQUE (tick_id, name, subject)
  )`);
  db.run(`CREATE INDEX idx_belief_rule_id ON belief (rule_id)`);
  db.run(`CREATE TABLE cfg (key TEXT PRIMARY KEY, value_int INTEGER, value_text TEXT)`);
  return db;
}

function insertTick(db: Database, nowMs: number, host = "h1"): number {
  db.run("INSERT INTO tick (now_ms, host) VALUES (?, ?)", [nowMs, host]);
  return (db.query("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
}

function insertBelief(
  db: Database,
  tickId: number,
  name: string,
  subject: string,
  ruleId = "R1",
  value: string | null = null,
): void {
  db.run(
    `INSERT OR IGNORE INTO belief (tick_id, stratum, name, subject, value, rule_id, source_fact_ids)
     VALUES (?, 1, ?, ?, ?, ?, '[]')`,
    [tickId, name, subject, value, ruleId],
  );
}

// ─── 1. beliefRulesManifest() — no db needed ────────────────────────────────

describe("RULE_MANIFEST shape", () => {
  it("has strata[] and rules[] arrays", () => {
    expect(Array.isArray(RULE_MANIFEST.strata)).toBe(true);
    expect(Array.isArray(RULE_MANIFEST.rules)).toBe(true);
  });

  it("first rule is R1 session_registered", () => {
    expect(RULE_MANIFEST.rules[0]?.rule_id).toBe("R1");
    expect(RULE_MANIFEST.rules[0]?.name).toBe("session_registered");
  });

  it("RULE_MANIFEST is frozen", () => {
    expect(Object.isFrozen(RULE_MANIFEST)).toBe(true);
  });
});

// ─── 2. beliefSummary — latest tick only ────────────────────────────────────

describe("beliefSummary", () => {
  it("excludes older-tick counts; tickId matches latest", () => {
    const db = makeDb();
    const t1 = insertTick(db, 1000);
    const t2 = insertTick(db, 2000);
    insertBelief(db, t1, "session_registered", "CTL-1/plan");
    insertBelief(db, t2, "session_registered", "CTL-1/plan");
    insertBelief(db, t2, "session_registered", "CTL-2/plan");
    const result = beliefSummary(db) as { tickId: number; rows: Array<{ name: string; subjects: number; total: number }> };
    expect(result.tickId).toBe(t2);
    const row = result.rows.find((r) => r.name === "session_registered");
    expect(row?.subjects).toBe(2); // only tick 2's 2 subjects
    db.close();
  });

  it("empty belief table returns {tickId:null, rows:[]}", () => {
    const db = makeDb();
    const result = beliefSummary(db) as { tickId: null; rows: unknown[] };
    expect(result.tickId).toBeNull();
    expect(result.rows).toEqual([]);
    db.close();
  });
});

// ─── 3. beliefSummary — empty table no throw ─────────────────────────────────

// (covered above)

// ─── 4. beliefRates — counts per rule_id per tick ──────────────────────────

describe("beliefRates", () => {
  it("returns count per rule_id per tick, maxTick correct", () => {
    const db = makeDb();
    const t1 = insertTick(db, 1000);
    const t2 = insertTick(db, 2000);
    insertBelief(db, t1, "a", "s1", "R1");
    insertBelief(db, t2, "b", "s2", "R2");
    insertBelief(db, t2, "c", "s3", "R2");
    const lru = new Map();
    const result = beliefRates(db, lru) as { maxTick: number; rows: Array<{ tick_id: number; rule_id: string; count: number }> };
    expect(result.maxTick).toBe(t2);
    const r2rows = result.rows.filter((r) => r.rule_id === "R2");
    const totalR2 = r2rows.reduce((s, r) => s + r.count, 0);
    expect(totalR2).toBe(2);
    db.close();
  });

  // ─── 5. LRU behavior ─────────────────────────────────────────────────────

  it("second call with unchanged maxTick returns same object reference", () => {
    const db = makeDb();
    const t1 = insertTick(db, 1000);
    insertBelief(db, t1, "a", "s1", "R1");
    const lru = new Map();
    const r1 = beliefRates(db, lru);
    const r2 = beliefRates(db, lru);
    expect(r1).toBe(r2);
    db.close();
  });

  it("recomputes after a new tick is inserted", () => {
    const db = makeDb();
    const t1 = insertTick(db, 1000);
    insertBelief(db, t1, "a", "s1", "R1");
    const lru = new Map();
    const r1 = beliefRates(db, lru);
    const t2 = insertTick(db, 2000);
    insertBelief(db, t2, "b", "s2", "R2");
    const r2 = beliefRates(db, lru);
    expect(r1).not.toBe(r2);
    db.close();
  });

  it("LRU size never exceeds RATES_LRU_CAP", () => {
    const db = makeDb();
    const lru = new Map();
    // Insert enough ticks to exceed the cap
    for (let i = 0; i <= RATES_LRU_CAP + 5; i++) {
      const t = insertTick(db, 1000 + i);
      insertBelief(db, t, `n${i}`, `s${i}`, "R1");
      beliefRates(db, lru);
    }
    expect(lru.size).toBeLessThanOrEqual(RATES_LRU_CAP);
    db.close();
  });
});

// ─── 6. beliefRecent — newest-first, limit, join with tick ─────────────────

describe("beliefRecent", () => {
  it("returns newest-first up to limit", () => {
    const db = makeDb();
    const t1 = insertTick(db, 1000);
    const t2 = insertTick(db, 2000);
    insertBelief(db, t1, "a", "s1");
    insertBelief(db, t2, "b", "s2");
    const result = beliefRecent(db, { limit: 10 }) as { rows: Array<{ name: string; ts_ms: number }> };
    expect(result.rows.length).toBe(2);
    // newest first
    expect(result.rows[0]?.ts_ms).toBe(2000);
    db.close();
  });

  it("default limit is RECENT_DEFAULT_LIMIT", () => {
    expect(RECENT_DEFAULT_LIMIT).toBe(50);
  });
});

// ─── 7. beliefCfg — returns cfg rows ─────────────────────────────────────

describe("beliefCfg", () => {
  it("returns cfg rows", () => {
    const db = makeDb();
    db.run("INSERT INTO cfg (key, value_int) VALUES ('max_parallel', 6)");
    const result = beliefCfg(db) as { rows: Array<{ key: string; value_int: number }> };
    expect(result.rows.some((r) => r.key === "max_parallel")).toBe(true);
    db.close();
  });

  it("empty cfg returns rows:[]", () => {
    const db = makeDb();
    const result = beliefCfg(db) as { rows: unknown[] };
    expect(result.rows).toEqual([]);
    db.close();
  });
});

// ─── HTTP integration tests ──────────────────────────────────────────────────

let server: ReturnType<typeof createServer>;
let baseUrl: string;
let tmpDir: string;
let beliefsDbPath: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "beliefs-read-test-"));
  const dbPath = join(tmpDir, "catalyst.db");
  beliefsDbPath = join(tmpDir, "beliefs.db"); // does NOT exist — absent db tests
  server = createServer({
    port: 0,
    startWatcher: false,
    dbPath,
    beliefStoreDbPath: beliefsDbPath, // explicitly absent — forces degradation
  });
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(() => {
  void server?.stop(true);
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ─── 8. HTTP routes — seeded db ─────────────────────────────────────────────

describe("GET /api/beliefs/* HTTP (with seeded db)", () => {
  let seededServer: ReturnType<typeof createServer>;
  let seededUrl: string;
  let seededDir: string;

  beforeAll(async () => {
    seededDir = mkdtempSync(join(tmpdir(), "beliefs-seeded-"));
    const dbPath = join(seededDir, "catalyst.db");
    const beliefPath = join(seededDir, "beliefs.db");
    // Seed the beliefs db via openBeliefsDb (runs migrations)
    const schemaSpecifier = ["../../execution-core/beliefs/schema.mjs"].join("");
    const { openBeliefsDb } = await import(schemaSpecifier) as {
      openBeliefsDb: (opts: { path: string }) => Database;
    };
    const bdb = openBeliefsDb({ path: beliefPath });
    const t1 = insertTick(bdb, 1000);
    insertBelief(bdb, t1, "session_registered", "CTL-1/plan", "R1");
    bdb.run("INSERT OR IGNORE INTO cfg (key, value_int) VALUES ('max_parallel', 6)");
    bdb.close();

    seededServer = createServer({
      port: 0,
      startWatcher: false,
      dbPath,
      beliefStoreDbPath: beliefPath,
    });
    seededUrl = `http://localhost:${seededServer.port}`;
  });

  afterAll(() => {
    void seededServer?.stop(true);
    try { rmSync(seededDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("GET /api/beliefs/rules → 200 with rules manifest (no db needed)", async () => {
    const res = await fetch(`${seededUrl}/api/beliefs/rules`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = await res.json() as { rules: Array<{ rule_id: string }> };
    expect(Array.isArray(body.rules)).toBe(true);
    expect(body.rules.length).toBeGreaterThan(0);
    expect(body.rules[0]?.rule_id).toBe("R1");
  });

  it("GET /api/beliefs/summary → 200 with shape {tickId, rows}", async () => {
    const res = await fetch(`${seededUrl}/api/beliefs/summary`);
    expect(res.status).toBe(200);
    const body = await res.json() as { tickId: number; rows: unknown[] };
    expect("tickId" in body).toBe(true);
    expect(Array.isArray(body.rows)).toBe(true);
  });

  it("GET /api/beliefs/rates → 200 with {maxTick, rows}", async () => {
    const res = await fetch(`${seededUrl}/api/beliefs/rates`);
    expect(res.status).toBe(200);
    const body = await res.json() as { maxTick: unknown; rows: unknown[] };
    expect("maxTick" in body).toBe(true);
    expect(Array.isArray(body.rows)).toBe(true);
  });

  it("GET /api/beliefs/recent → 200 with {rows}", async () => {
    const res = await fetch(`${seededUrl}/api/beliefs/recent`);
    expect(res.status).toBe(200);
    const body = await res.json() as { rows: unknown[] };
    expect(Array.isArray(body.rows)).toBe(true);
  });

  it("GET /api/beliefs/cfg → 200 with {rows}", async () => {
    const res = await fetch(`${seededUrl}/api/beliefs/cfg`);
    expect(res.status).toBe(200);
    const body = await res.json() as { rows: unknown[] };
    expect(Array.isArray(body.rows)).toBe(true);
  });
});

// ─── 9. HTTP graceful degradation (absent db) ────────────────────────────────

describe("GET /api/beliefs/* HTTP graceful degradation (absent db)", () => {
  it("/api/beliefs/rules → manifest (needs no db)", async () => {
    const res = await fetch(`${baseUrl}/api/beliefs/rules`);
    expect(res.status).toBe(200);
    const body = await res.json() as { rules: unknown[] };
    expect(Array.isArray(body.rules)).toBe(true);
    expect(body.rules.length).toBeGreaterThan(0);
  });

  it("/api/beliefs/summary → 200 {tickId:null,rows:[]}", async () => {
    const res = await fetch(`${baseUrl}/api/beliefs/summary`);
    expect(res.status).toBe(200);
    const body = await res.json() as { tickId: null; rows: unknown[] };
    expect(body.tickId).toBeNull();
    expect(body.rows).toEqual([]);
  });

  it("/api/beliefs/rates → 200 {maxTick:null,rows:[]}", async () => {
    const res = await fetch(`${baseUrl}/api/beliefs/rates`);
    expect(res.status).toBe(200);
    const body = await res.json() as { maxTick: null; rows: unknown[] };
    expect(body.maxTick).toBeNull();
    expect(body.rows).toEqual([]);
  });

  it("/api/beliefs/recent → 200 {rows:[]}", async () => {
    const res = await fetch(`${baseUrl}/api/beliefs/recent`);
    expect(res.status).toBe(200);
    const body = await res.json() as { rows: unknown[] };
    expect(body.rows).toEqual([]);
  });

  it("/api/beliefs/cfg → 200 {rows:[]}", async () => {
    const res = await fetch(`${baseUrl}/api/beliefs/cfg`);
    expect(res.status).toBe(200);
    const body = await res.json() as { rows: unknown[] };
    expect(body.rows).toEqual([]);
  });
});
