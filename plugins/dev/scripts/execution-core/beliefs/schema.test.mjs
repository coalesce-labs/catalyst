// schema.test.mjs — CTL-933 belief-store Step 1: schema creation, idempotent
// re-open, cfg seeding, and db-path resolution (env override).
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  openBeliefsDb,
  defaultBeliefsDbPath,
  CFG_SEED,
} from "./schema.mjs";

const tmps = [];
function scratch() {
  const d = mkdtempSync(join(tmpdir(), "ctl933-schema-"));
  tmps.push(d);
  return d;
}
afterEach(() => {
  while (tmps.length) {
    try {
      rmSync(tmps.pop(), { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

const SPEC_TABLES = [
  "tick",
  "obs_agent",
  "obs_job",
  "obs_signal",
  "obs_transcript",
  "obs_heartbeat",
  "obs_linear",
  "cfg",
  "belief",
  "intent",
  "shadow_comparison",
];

function tableNames(db) {
  return db
    .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((r) => r.name);
}

function columns(db, table) {
  return db.query(`PRAGMA table_info(${table})`).all().map((r) => r.name);
}

function colInfo(db, table, col) {
  return db.query(`PRAGMA table_info(${table})`).all().find((r) => r.name === col);
}

function fkList(db, table) {
  return db.query(`PRAGMA foreign_key_list(${table})`).all();
}

describe("openBeliefsDb — spec §1 schema", () => {
  test("creates every spec §1 table", () => {
    const db = openBeliefsDb({ path: join(scratch(), "beliefs.db") });
    const names = tableNames(db);
    for (const t of SPEC_TABLES) expect(names).toContain(t);
    db.close();
  });

  test("spec §1 columns are present verbatim per table", () => {
    const db = openBeliefsDb({ path: join(scratch(), "beliefs.db") });
    expect(columns(db, "tick")).toEqual(["tick_id", "now_ms", "host", "rules_sha"]);
    expect(columns(db, "obs_agent")).toEqual([
      "fact_id", "tick_id", "session_id", "short_id", "kind", "status",
      "state", "cwd", "name", "pid", "started_at_ms",
    ]);
    expect(columns(db, "obs_job")).toEqual([
      "fact_id", "tick_id", "bg_job_id", "state", "tempo", "detail", "needs",
      "first_terminal_at", "cli_version", "created_at_ms", "updated_at_ms",
      "mtime_ms", "exists_flag",
    ]);
    expect(columns(db, "obs_signal")).toEqual([
      "fact_id", "tick_id", "ticket", "phase", "status", "bg_job_id",
      "generation", "started_at_ms", "updated_at_ms",
    ]);
    expect(columns(db, "obs_transcript")).toEqual([
      "fact_id", "tick_id", "session_id", "exists_flag", "mtime_ms", "bytes",
    ]);
    expect(columns(db, "obs_heartbeat")).toEqual([
      "fact_id", "ticket", "phase", "generation", "host", "kind", "ts_ms",
    ]);
    expect(columns(db, "obs_linear")).toEqual([
      "fact_id", "tick_id", "ticket", "state",
    ]);
    expect(columns(db, "cfg")).toEqual(["key", "value_int", "value_text"]);
    expect(columns(db, "belief")).toEqual([
      "belief_id", "tick_id", "stratum", "name", "subject", "value",
      "rule_id", "source_fact_ids",
    ]);
    expect(columns(db, "intent")).toEqual([
      "intent_id", "tick_id", "kind", "subject", "belief_id",
      "postcondition", "attempts", "outcome",
    ]);
    db.close();
  });

  test("constraints land verbatim: NOT NULLs, defaults, and cfg PK (PRAGMA-checked)", () => {
    const db = openBeliefsDb({ path: join(scratch(), "beliefs.db") });

    // tick — both payload columns mandatory
    expect(colInfo(db, "tick", "now_ms").notnull).toBe(1);
    expect(colInfo(db, "tick", "host").notnull).toBe(1);

    // obs_job.exists_flag — NOT NULL DEFAULT 1 (0 = job dir gone)
    const ef = colInfo(db, "obs_job", "exists_flag");
    expect(ef.notnull).toBe(1);
    expect(Number(ef.dflt_value)).toBe(1);
    // … and the default actually applies on a bare insert
    db.run("INSERT INTO tick (now_ms, host) VALUES (1, 'h')");
    db.run("INSERT INTO obs_job (tick_id, bg_job_id) VALUES (1, 'j1')");
    expect(db.query("SELECT exists_flag FROM obs_job").get().exists_flag).toBe(1);

    // intent.attempts — DEFAULT 0
    const at = colInfo(db, "intent", "attempts");
    expect(Number(at.dflt_value)).toBe(0);
    db.run("INSERT INTO intent (tick_id, kind, subject) VALUES (1, 'kill', 's')");
    expect(db.query("SELECT attempts FROM intent").get().attempts).toBe(0);

    // cfg.key — PRIMARY KEY
    expect(colInfo(db, "cfg", "key").pk).toBe(1);

    // belief — provenance is MANDATORY (rule_id + source_fact_ids NOT NULL)
    expect(colInfo(db, "belief", "rule_id").notnull).toBe(1);
    expect(colInfo(db, "belief", "source_fact_ids").notnull).toBe(1);
    expect(() =>
      db.run(
        "INSERT INTO belief (tick_id, stratum, name, subject, rule_id, source_fact_ids) VALUES (1, 1, 'b', 's', NULL, '[]')",
      ),
    ).toThrow();
    expect(() =>
      db.run(
        "INSERT INTO belief (tick_id, stratum, name, subject, rule_id, source_fact_ids) VALUES (1, 1, 'b', 's', 'R1', NULL)",
      ),
    ).toThrow();

    // other NOT NULLs the rules depend on
    expect(colInfo(db, "obs_agent", "session_id").notnull).toBe(1);
    expect(colInfo(db, "obs_agent", "short_id").notnull).toBe(1);
    expect(colInfo(db, "obs_job", "bg_job_id").notnull).toBe(1);
    expect(colInfo(db, "obs_signal", "ticket").notnull).toBe(1);
    expect(colInfo(db, "obs_signal", "phase").notnull).toBe(1);
    expect(colInfo(db, "obs_transcript", "exists_flag").notnull).toBe(1);
    expect(colInfo(db, "obs_heartbeat", "ts_ms").notnull).toBe(1);
    expect(colInfo(db, "obs_linear", "ticket").notnull).toBe(1);
    db.close();
  });

  test("FK clauses are declared per spec §1 (PRAGMA foreign_key_list)", () => {
    const db = openBeliefsDb({ path: join(scratch(), "beliefs.db") });
    for (const t of ["obs_agent", "obs_job", "obs_signal", "obs_transcript", "obs_linear", "belief"]) {
      const fks = fkList(db, t);
      expect(fks.length).toBe(1);
      expect(fks[0].table).toBe("tick");
      expect(fks[0].from).toBe("tick_id");
      expect(fks[0].to).toBe("tick_id");
    }
    // intent.belief_id → belief(belief_id); obs_heartbeat has no tick_id (own ts_ms)
    const intentFks = fkList(db, "intent");
    expect(intentFks.length).toBe(1);
    expect(intentFks[0].table).toBe("belief");
    expect(intentFks[0].from).toBe("belief_id");
    expect(fkList(db, "obs_heartbeat").length).toBe(0);
    db.close();
  });

  test("belief UNIQUE(tick_id, name, subject) rejects a duplicate derivation", () => {
    const db = openBeliefsDb({ path: join(scratch(), "beliefs.db") });
    db.run("INSERT INTO tick (now_ms, host) VALUES (1, 'h')");
    const ins =
      "INSERT INTO belief (tick_id, stratum, name, subject, rule_id, source_fact_ids) VALUES (1, 2, 'wedged_never_started', 'CTL-722/plan', 'R4', '[]')";
    db.run(ins);
    expect(() => db.run(ins)).toThrow(); // plain INSERT → constraint violation
    // INSERT OR IGNORE (the spec §4 compilation pattern) is the sanctioned dedupe
    db.run(ins.replace("INSERT", "INSERT OR IGNORE"));
    expect(db.query("SELECT COUNT(*) AS n FROM belief").get().n).toBe(1);
    // same name+subject under a DIFFERENT tick is fine
    db.run("INSERT INTO tick (now_ms, host) VALUES (2, 'h')");
    db.run(ins.replace("VALUES (1,", "VALUES (2,"));
    expect(db.query("SELECT COUNT(*) AS n FROM belief").get().n).toBe(2);
    db.close();
  });

  test("seeds cfg from the spec §1 comments", () => {
    const db = openBeliefsDb({ path: join(scratch(), "beliefs.db") });
    const rows = Object.fromEntries(
      db.query("SELECT key, value_int FROM cfg").all().map((r) => [r.key, r.value_int]),
    );
    expect(rows.max_parallel).toBe(6);
    expect(rows.session_cap).toBe(10);
    expect(rows.never_started_ms).toBe(120000);
    expect(rows.lease_window_build_ms).toBe(1800000);
    expect(rows.lease_window_doc_ms).toBe(2700000);
    expect(CFG_SEED.length).toBeGreaterThanOrEqual(5);
    db.close();
  });

  test("re-open is idempotent and never clobbers operator-tuned cfg", () => {
    const path = join(scratch(), "beliefs.db");
    const db1 = openBeliefsDb({ path });
    db1.run("UPDATE cfg SET value_int = 42 WHERE key = 'max_parallel'");
    db1.run("INSERT INTO tick (now_ms, host) VALUES (1, 'h')");
    db1.close();

    const db2 = openBeliefsDb({ path }); // must not throw on existing schema
    const cfg = db2.query("SELECT value_int FROM cfg WHERE key='max_parallel'").get();
    expect(cfg.value_int).toBe(42); // INSERT OR IGNORE seeding — tuned value survives
    const tick = db2.query("SELECT COUNT(*) AS n FROM tick").get();
    expect(tick.n).toBe(1); // existing data survives re-migration
    db2.close();
  });
});

describe("openBeliefsDb — CTL-1063 Phase 4: rules_sha column + idx_belief_rule_id", () => {
  test("tick.rules_sha column exists and is nullable", () => {
    const db = openBeliefsDb({ path: join(scratch(), "beliefs.db") });
    expect(columns(db, "tick")).toContain("rules_sha");
    const info = colInfo(db, "tick", "rules_sha");
    expect(info.notnull).toBe(0); // nullable — NULL is valid before RULES_SHA is seeded
    db.close();
  });

  test("idx_belief_rule_id index exists on belief table", () => {
    const db = openBeliefsDb({ path: join(scratch(), "beliefs.db") });
    const indexes = db.query("PRAGMA index_list(belief)").all().map((r) => r.name);
    expect(indexes).toContain("idx_belief_rule_id");
    db.close();
  });

  test("re-opening an existing db that already has rules_sha does NOT throw (idempotent ALTER)", () => {
    const path = join(scratch(), "beliefs.db");
    const db1 = openBeliefsDb({ path });
    db1.run("INSERT INTO tick (now_ms, host, rules_sha) VALUES (1, 'h', 'abc123')");
    db1.close();
    // Second open: ALTER TABLE tick ADD COLUMN rules_sha is guarded by the PRAGMA check
    expect(() => {
      const db2 = openBeliefsDb({ path });
      db2.close();
    }).not.toThrow();
    // Data survives the re-open
    const db3 = openBeliefsDb({ path });
    const row = db3.query("SELECT rules_sha FROM tick").get();
    expect(row.rules_sha).toBe("abc123");
    db3.close();
  });
});

describe("defaultBeliefsDbPath — env override", () => {
  test("CATALYST_BELIEFS_DB wins outright", () => {
    const p = defaultBeliefsDbPath({ CATALYST_BELIEFS_DB: "/tmp/x/beliefs-override.db" });
    expect(p).toBe("/tmp/x/beliefs-override.db");
  });

  test("falls back to <catalyst dir>/beliefs.db", () => {
    const p = defaultBeliefsDbPath({ CATALYST_DIR: "/tmp/cat-dir" });
    expect(p).toBe(join("/tmp/cat-dir", "beliefs.db"));
  });

  test("openBeliefsDb honors the env override end-to-end", () => {
    const dir = scratch();
    const target = join(dir, "custom-name.db");
    const db = openBeliefsDb({ env: { CATALYST_BELIEFS_DB: target } });
    db.run("INSERT INTO tick (now_ms, host) VALUES (2, 'h')");
    db.close();
    expect(existsSync(target)).toBe(true);
  });
});

describe("openBeliefsDb — CTL-935: shadow_comparison table", () => {
  test("creates shadow_comparison with exact column set in order", () => {
    const db = openBeliefsDb({ path: join(scratch(), "beliefs.db") });
    expect(columns(db, "shadow_comparison")).toEqual([
      "cmp_id", "tick_id", "dimension", "subject", "agree",
      "procedural", "belief", "differing_input", "legacy_guard",
      "rule_id", "rules_sha",
    ]);
    db.close();
  });

  test("UNIQUE(tick_id, dimension, subject): duplicate plain INSERT throws; INSERT OR IGNORE leaves COUNT=1", () => {
    const db = openBeliefsDb({ path: join(scratch(), "beliefs.db") });
    db.run("INSERT INTO tick (now_ms, host) VALUES (1, 'mini')");
    const ins = "INSERT INTO shadow_comparison (tick_id, dimension, subject, agree) VALUES (1, 'advance', 'CTL-1', 1)";
    db.run(ins);
    expect(() => db.run(ins)).toThrow();
    db.run(ins.replace("INSERT", "INSERT OR IGNORE"));
    expect(db.query("SELECT COUNT(*) AS n FROM shadow_comparison").get().n).toBe(1);
    // same (dimension,subject) under a new tick_id inserts a second row
    db.run("INSERT INTO tick (now_ms, host) VALUES (2, 'mini')");
    db.run("INSERT INTO shadow_comparison (tick_id, dimension, subject, agree) VALUES (2, 'advance', 'CTL-1', 0)");
    expect(db.query("SELECT COUNT(*) AS n FROM shadow_comparison").get().n).toBe(2);
    db.close();
  });

  test("FK shadow_comparison.tick_id -> tick(tick_id) is declared", () => {
    const db = openBeliefsDb({ path: join(scratch(), "beliefs.db") });
    const fks = fkList(db, "shadow_comparison");
    expect(fks.length).toBe(1);
    expect(fks[0].table).toBe("tick");
    expect(fks[0].from).toBe("tick_id");
    expect(fks[0].to).toBe("tick_id");
    db.close();
  });

  test("indexes idx_shadow_cmp_tick, idx_shadow_cmp_dim_rule, idx_shadow_cmp_guard exist", () => {
    const db = openBeliefsDb({ path: join(scratch(), "beliefs.db") });
    const idxs = db.query("PRAGMA index_list(shadow_comparison)").all().map((r) => r.name);
    expect(idxs).toContain("idx_shadow_cmp_tick");
    expect(idxs).toContain("idx_shadow_cmp_dim_rule");
    expect(idxs).toContain("idx_shadow_cmp_guard");
    db.close();
  });

  test("idempotent additive migration: pre-CTL-935 db (no shadow_comparison) does not throw and preserves existing tick rows", () => {
    const path = join(scratch(), "beliefs.db");
    // Simulate a pre-CTL-935 db by opening and manually dropping the table (if it existed)
    const db1 = openBeliefsDb({ path });
    db1.run("INSERT INTO tick (now_ms, host) VALUES (1, 'h')");
    db1.run(
      "INSERT INTO belief (tick_id, stratum, name, subject, rule_id, source_fact_ids) VALUES (1, 1, 'x', 's', 'R1', '[]')",
    );
    db1.run("DROP TABLE IF EXISTS shadow_comparison");
    db1.close();
    // Re-open must create the table without throwing and preserve existing rows
    expect(() => {
      const db2 = openBeliefsDb({ path });
      const names = db2.query("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
      expect(names).toContain("shadow_comparison");
      expect(db2.query("SELECT COUNT(*) AS n FROM belief").get().n).toBe(1);
      db2.close();
    }).not.toThrow();
  });
});
