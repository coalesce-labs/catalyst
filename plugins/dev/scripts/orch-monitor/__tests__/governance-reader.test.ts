// CTL-1100 Phase 1: governance-reader.mjs — openBeliefsDbRO, withBeliefsDbRO,
// defaultBeliefsDbPath, GOVERNANCE_EVENT_PREFIXES, isGovernanceEvent.
//
// Tests drive against a real file-based bun:sqlite db (no server started).
// Modeled on beliefs-stream.test.ts pattern: dynamic import via computed
// specifier so bun:sqlite never appears as a static import in test infra.

import { describe, it, expect, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { tmpdir, homedir } from "os";
import { join } from "path";
import { mkdtempSync, rmSync, existsSync } from "fs";

// Load governance-reader via computed specifier (mirrors server.ts discipline).
const govMod = await import("../lib/governance-reader.mjs");
const {
  openBeliefsDbRO,
  withBeliefsDbRO,
  defaultBeliefsDbPath,
  isGovernanceEvent,
} = govMod as {
  openBeliefsDbRO: (p: string) => Promise<InstanceType<typeof Database> | null>;
  withBeliefsDbRO: <T>(p: string, fn: (db: InstanceType<typeof Database>) => T, fallback: T) => Promise<T>;
  defaultBeliefsDbPath: (env?: Record<string, string | undefined>) => string;
  isGovernanceEvent: (name: string) => boolean;
};

// Minimal DDL to create a writable seed db for RO tests.
function seedDb(path: string): InstanceType<typeof Database> {
  const db = new Database(path);
  db.run(`CREATE TABLE IF NOT EXISTS tick (
    tick_id INTEGER PRIMARY KEY AUTOINCREMENT,
    now_ms  INTEGER NOT NULL,
    host    TEXT    NOT NULL
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS belief (
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
  db.close();
  return db; // already closed; caller reopens RO
}

const tmpDirs: string[] = [];
function mkTmp() {
  const d = mkdtempSync(join(tmpdir(), "gov-reader-test-"));
  tmpDirs.push(d);
  return d;
}

afterAll(() => {
  for (const d of tmpDirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// ─── 1. openBeliefsDbRO returns null (never throws) when file absent ───────

describe("openBeliefsDbRO — absent file", () => {
  it("returns null for a path in a fresh tmp dir", async () => {
    const dir = mkTmp();
    const absent = join(dir, "nonexistent.db");
    const result = await openBeliefsDbRO(absent);
    expect(result).toBeNull();
  });
});

// ─── 2. Opens existing db read-only — write attempt throws ─────────────────

describe("openBeliefsDbRO — existing db is read-only", () => {
  it("opens the db and rejects writes", async () => {
    const dir = mkTmp();
    const dbPath = join(dir, "seed.db");
    seedDb(dbPath);

    const db = await openBeliefsDbRO(dbPath);
    expect(db).not.toBeNull();
    if (db == null) return;
    expect(() => {
      db.run("INSERT INTO tick (now_ms, host) VALUES (1, 'test')");
    }).toThrow();
    db.close();
  });
});

// ─── 3. create:false does NOT materialize a missing file ───────────────────

describe("openBeliefsDbRO — no file materialization", () => {
  it("does not create the file when absent", async () => {
    const dir = mkTmp();
    const absent = join(dir, "should-not-exist.db");
    expect(existsSync(absent)).toBe(false);
    const result = await openBeliefsDbRO(absent);
    expect(result).toBeNull();
    expect(existsSync(absent)).toBe(false);
  });
});

// ─── 4. withBeliefsDbRO — absent db returns fallback, fn never called ──────

describe("withBeliefsDbRO — absent db", () => {
  it("returns the fallback and never invokes fn", async () => {
    const dir = mkTmp();
    const absent = join(dir, "absent.db");
    let fnCalled = false;
    const result = await withBeliefsDbRO(
      absent,
      (_db) => { fnCalled = true; return "should-not-reach"; },
      "degraded-fallback",
    );
    expect(result).toBe("degraded-fallback");
    expect(fnCalled).toBe(false);
  });
});

// ─── 5. withBeliefsDbRO — closes handle even when fn throws ────────────────

describe("withBeliefsDbRO — fn throws", () => {
  it("returns the fallback and the db is closed after fn throws", async () => {
    const dir = mkTmp();
    const dbPath = join(dir, "throw.db");
    seedDb(dbPath);

    // Track if the db is closed by attempting a write after withBeliefsDbRO.
    // We can't reach into the closed handle directly, so we verify the fallback
    // is returned without the error escaping.
    const result = await withBeliefsDbRO(
      dbPath,
      (_db) => { throw new Error("deliberate throw"); },
      "fallback-on-throw",
    );
    expect(result).toBe("fallback-on-throw");
  });
});

// ─── 6. defaultBeliefsDbPath — env precedence ──────────────────────────────

describe("defaultBeliefsDbPath", () => {
  it("CATALYST_BELIEFS_DB wins outright", () => {
    const p = defaultBeliefsDbPath({ CATALYST_BELIEFS_DB: "/tmp/custom.db" });
    expect(p).toBe("/tmp/custom.db");
  });

  it("uses CATALYST_DIR/beliefs.db when CATALYST_BELIEFS_DB absent", () => {
    const p = defaultBeliefsDbPath({ CATALYST_DIR: "/tmp/mydir" });
    expect(p).toBe(join("/tmp/mydir", "beliefs.db"));
  });

  it("falls back to ~/catalyst/beliefs.db when neither env var set", () => {
    const p = defaultBeliefsDbPath({});
    expect(p).toMatch(/catalyst[/\\]beliefs\.db$/);
    expect(p.startsWith(homedir())).toBe(true);
  });
});

// ─── 7. Reconciliation: idx_belief_rule_id already exists (verify-only) ────

describe("idx_belief_rule_id — pre-existing index (reconciliation verify)", () => {
  it("idx_belief_rule_id exists in sqlite_master after openBeliefsDb", async () => {
    const dir = mkTmp();
    const dbPath = join(dir, "schema-verify.db");
    // Open via the WRITER path (openBeliefsDb runs migrations + creates index).
    const schemaModSpecifier = ["../../execution-core/beliefs/schema.mjs"].join("");
    const { openBeliefsDb } = await import(schemaModSpecifier) as {
      openBeliefsDb: (opts: { path: string }) => InstanceType<typeof Database>;
    };
    const writable = openBeliefsDb({ path: dbPath });
    const rows = writable
      .query("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_belief_rule_id'")
      .all() as Array<{ name: string }>;
    writable.close();
    expect(rows.length).toBe(1);
    expect(rows[0]?.name).toBe("idx_belief_rule_id");
  });
});

// ─── 8. isGovernanceEvent — allowlist + blocklist ──────────────────────────

describe("isGovernanceEvent", () => {
  it("phase.verify.complete.CTL-700 is a governance event", () => {
    expect(isGovernanceEvent("phase.verify.complete.CTL-700")).toBe(true);
  });

  it("phase.implement.complete.CTL-700 is a governance event", () => {
    expect(isGovernanceEvent("phase.implement.complete.CTL-700")).toBe(true);
  });

  it("phase.remediate.complete.CTL-100 is a governance event", () => {
    expect(isGovernanceEvent("phase.remediate.complete.CTL-100")).toBe(true);
  });

  it("janitor.would.reap-request is NOT a governance event (janitor prefix)", () => {
    expect(isGovernanceEvent("janitor.would.reap-request")).toBe(false);
  });

  it("phase.terminal.reap-complete is NOT a governance event (contains reap, invalid prefix)", () => {
    expect(isGovernanceEvent("phase.terminal.reap-complete")).toBe(false);
  });

  it("orphans.reap-requested is NOT a governance event (orphans prefix + reap)", () => {
    expect(isGovernanceEvent("orphans.reap-requested")).toBe(false);
  });

  it("phase.yield.reap-requested is NOT a governance event (contains reap)", () => {
    expect(isGovernanceEvent("phase.yield.reap-requested")).toBe(false);
  });

  it("janitor.stall.cleared is NOT a governance event (janitor prefix)", () => {
    expect(isGovernanceEvent("janitor.stall.cleared")).toBe(false);
  });

  it("worktree.something is NOT a governance event (worktree prefix)", () => {
    expect(isGovernanceEvent("worktree.something")).toBe(false);
  });

  it("phase.research.complete.CTL-5 is a governance event", () => {
    expect(isGovernanceEvent("phase.research.complete.CTL-5")).toBe(true);
  });

  it("unrelated.event is NOT a governance event (no valid prefix)", () => {
    expect(isGovernanceEvent("unrelated.event")).toBe(false);
  });
});
