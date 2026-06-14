// beliefs/manifest.test.mjs — CTL-1063 Phase 5: RULE_MANIFEST tests.
//
// Test coverage:
//   1. cfgConsumers — correct extraction from live SQL constants
//   2. checkCfgAnnotations — error reporting for bogus @cfg key
//   3. checkFeedsAnnotations — passes for valid @feeds, fails for unknown rule
//   4. @example doctests — R4 and R1 examples execute and produce expected belief
//   5. RULE_MANIFEST shape — 17 rules, 18 total arms, all required keys present
//   6. arms[].sql trim-equals the live STRATA SQL constants
//   7. R4.negates = ['turn_started','worker_dead'], R4.cfg_keys = ['never_started_ms']
//   8. Object.isFrozen(RULE_MANIFEST)

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { cfgConsumers } from "./compiler/cfg-consumers.mjs";
import { checkCfgAnnotations, checkFeedsAnnotations } from "./compiler/annotations.mjs";
import { RULE_MANIFEST } from "./rules.generated.mjs";
import { openBeliefsDb } from "./schema.mjs";
import { evaluateBeliefs } from "./rules.mjs";
import {
  R4_wedged_never_started,
  R1_session_registered,
  R5_lease_valid,
  R8_free_slots,
  R10a_wake_diagnostician,
  R11_action_ineffective,
  R15_ready,
  GENERATED_STRATA,
} from "./rules.generated.mjs";

// ── Scratch dirs ──────────────────────────────────────────────────────────────
const tmps = [];
function scratch() {
  const d = mkdtempSync(join(tmpdir(), "ctl1063-manifest-"));
  tmps.push(d);
  return d;
}
let db;
beforeEach(() => {
  db = openBeliefsDb({ path: join(scratch(), "b.db") });
});
afterEach(() => {
  try { db.close(); } catch { /* already closed */ }
  while (tmps.length) {
    try { rmSync(tmps.pop(), { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

// ── fixture helpers ───────────────────────────────────────────────────────────
function tick(now, host = "mini") {
  db.run("INSERT INTO tick (now_ms, host) VALUES (?, ?)", [now, host]);
  return db.query("SELECT last_insert_rowid() AS id").get().id;
}
function signal(tickId, o) {
  db.run(
    `INSERT INTO obs_signal (tick_id, ticket, phase, status, bg_job_id, generation, started_at_ms, updated_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [tickId, o.ticket, o.phase, o.status ?? "running", o.bg_job_id ?? null,
     o.generation ?? null, o.started_at_ms ?? null, o.updated_at_ms ?? null],
  );
  return db.query("SELECT last_insert_rowid() AS id").get().id;
}
function agent(tickId, o) {
  db.run(
    `INSERT INTO obs_agent (tick_id, session_id, short_id, kind, status, state, started_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [tickId, o.session_id, o.short_id, o.kind ?? "background",
     o.status ?? null, o.state ?? null, o.started_at_ms ?? null],
  );
  return db.query("SELECT last_insert_rowid() AS id").get().id;
}
function cfg(key, value_int = null, value_text = null) {
  db.run("INSERT OR IGNORE INTO cfg (key, value_int, value_text) VALUES (?, ?, ?)",
    [key, value_int, value_text]);
}

// ── 1. cfgConsumers: correct extraction from live SQL constants ───────────────

describe("cfgConsumers", () => {
  test("R4: extracts never_started_ms from direct form", () => {
    const keys = cfgConsumers(R4_wedged_never_started);
    expect(keys).toEqual(["never_started_ms"]);
  });

  test("R5: extracts lease_window_doc_ms, lease_window_build_ms from CASE form", () => {
    const keys = cfgConsumers(R5_lease_valid);
    expect(keys).toContain("lease_window_doc_ms");
    expect(keys).toContain("lease_window_build_ms");
    expect(keys.length).toBe(2);
  });

  test("R8: extracts max_parallel, session_cap", () => {
    const keys = cfgConsumers(R8_free_slots);
    expect(keys).toContain("max_parallel");
    expect(keys).toContain("session_cap");
    expect(keys.length).toBe(2);
  });

  test("R10a: extracts diag_cooldown_ms", () => {
    const keys = cfgConsumers(R10a_wake_diagnostician);
    expect(keys).toContain("diag_cooldown_ms");
  });

  test("R11: extracts max_attempts", () => {
    const keys = cfgConsumers(R11_action_ineffective);
    expect(keys).toContain("max_attempts");
  });

  test("R15: extracts eligible_state (value_text key)", () => {
    const keys = cfgConsumers(R15_ready);
    expect(keys).toContain("eligible_state");
  });

  test("R1: returns empty array (no cfg join)", () => {
    const keys = cfgConsumers(R1_session_registered);
    expect(keys).toEqual([]);
  });

  test("deduplicates repeated keys", () => {
    const sql = "JOIN cfg a ON a.key = 'foo' JOIN cfg b ON b.key = 'foo' JOIN cfg c ON c.key = 'bar'";
    const keys = cfgConsumers(sql);
    expect(keys).toEqual(["foo", "bar"]);
  });
});

// ── 2. checkCfgAnnotations ────────────────────────────────────────────────────

describe("checkCfgAnnotations", () => {
  test("no errors when @cfg keys match SQL", () => {
    const errors = checkCfgAnnotations("R4", R4_wedged_never_started, ["never_started_ms"]);
    expect(errors).toEqual([]);
  });

  test("error when @cfg key is absent from SQL", () => {
    const errors = checkCfgAnnotations("R4", R4_wedged_never_started, ["bogus_key"]);
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("R4");
    expect(errors[0]).toContain("bogus_key");
  });

  test("error message includes rule_id and key", () => {
    const errors = checkCfgAnnotations("R8", R8_free_slots, ["nonexistent"]);
    expect(errors[0]).toMatch(/R8/);
    expect(errors[0]).toMatch(/nonexistent/);
  });

  test("no errors when annotated list is empty (R1)", () => {
    const errors = checkCfgAnnotations("R1", R1_session_registered, []);
    expect(errors).toEqual([]);
  });
});

// ── 3. checkFeedsAnnotations ──────────────────────────────────────────────────

describe("checkFeedsAnnotations", () => {
  const knownRules = new Set(["R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8",
    "R9", "R10", "R10a", "R10b", "R11", "R12", "R13", "R14", "R15", "R16", "R17"]);

  test("passes for R4 @feeds(R10) — valid reference", () => {
    const errors = checkFeedsAnnotations("R4", ["R10"], knownRules);
    expect(errors).toEqual([]);
  });

  test("fails for @feeds(R99) — unknown rule", () => {
    const errors = checkFeedsAnnotations("R4", ["R99"], knownRules);
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("R4");
    expect(errors[0]).toContain("R99");
  });

  test("accepts Map as well as Set", () => {
    // build a minimal Map<ruleId, {}> like the compiler's rulesMap
    const mapRules = new Map([["R10", {}], ["R11", {}]]);
    const errors = checkFeedsAnnotations("R4", ["R10"], mapRules);
    expect(errors).toEqual([]);
  });
});

// ── 4. @example doctests: R4 and R1 examples execute and pass ─────────────────

describe("@example doctests", () => {
  test("R4 example: wedged_never_started fires when expected", () => {
    const r4 = RULE_MANIFEST.rules.find(r => r.rule_id === "R4");
    expect(r4.examples.length).toBeGreaterThan(0);

    const ex = r4.examples[0];
    // ex.now is the tick time; ex.facts are rows to insert; ex.expect is the belief shape

    const tickId = tick(ex.now);
    cfg("never_started_ms", 60000);

    // Insert example facts
    for (const f of ex.facts) {
      if (f.table === "obs_signal") {
        signal(tickId, f.row);
      } else if (f.table === "obs_agent") {
        agent(tickId, f.row);
      } else if (f.table === "cfg") {
        // Already seeded above (INSERT OR IGNORE)
        db.run("INSERT OR IGNORE INTO cfg (key, value_int) VALUES (?, ?)",
          [f.row.key, f.row.value_int]);
      }
    }

    evaluateBeliefs(db, tickId);

    const beliefs = db.query(
      "SELECT name, subject, rule_id FROM belief WHERE tick_id = ? AND name = 'wedged_never_started'"
    ).all(tickId);

    expect(beliefs.length).toBeGreaterThan(0);
    const b = beliefs[0];
    expect(b.name).toBe(ex.expect.name);
    expect(b.subject).toBe(ex.expect.subject);
    expect(b.rule_id).toBe(ex.expect.rule_id);
  });

  test("R1 example: session_registered fires when expected", () => {
    const r1 = RULE_MANIFEST.rules.find(r => r.rule_id === "R1");
    expect(r1.examples.length).toBeGreaterThan(0);

    const ex = r1.examples[0];
    const tickId = tick(ex.now);

    for (const f of ex.facts) {
      if (f.table === "obs_signal") {
        signal(tickId, f.row);
      } else if (f.table === "obs_agent") {
        agent(tickId, f.row);
      }
    }

    evaluateBeliefs(db, tickId);

    const beliefs = db.query(
      "SELECT name, subject, rule_id FROM belief WHERE tick_id = ? AND name = 'session_registered'"
    ).all(tickId);

    expect(beliefs.length).toBeGreaterThan(0);
    const b = beliefs[0];
    expect(b.name).toBe(ex.expect.name);
    expect(b.subject).toBe(ex.expect.subject);
    expect(b.rule_id).toBe(ex.expect.rule_id);
  });
});

// ── 5. RULE_MANIFEST shape ────────────────────────────────────────────────────

describe("RULE_MANIFEST shape", () => {
  test("has 17 rules", () => {
    expect(RULE_MANIFEST.rules.length).toBe(17);
  });

  test("has 18 total arms (R10 contributes 2)", () => {
    const totalArms = RULE_MANIFEST.rules.reduce((sum, r) => sum + r.arms.length, 0);
    expect(totalArms).toBe(18);
  });

  test("has 6 strata", () => {
    expect(RULE_MANIFEST.strata.length).toBe(6);
  });

  test("all required rule keys present", () => {
    const REQUIRED_KEYS = [
      "rule_id", "name", "stratum", "extern", "feeds", "reads",
      "negates", "cfg_keys", "severity", "since", "ticket", "src", "arms", "examples",
    ];
    for (const rule of RULE_MANIFEST.rules) {
      for (const key of REQUIRED_KEYS) {
        expect(rule).toHaveProperty(key);
      }
    }
  });

  test("all arm objects have arm_id, datalog, sql", () => {
    for (const rule of RULE_MANIFEST.rules) {
      for (const arm of rule.arms) {
        expect(arm).toHaveProperty("arm_id");
        expect(arm).toHaveProperty("datalog");
        expect(arm).toHaveProperty("sql");
      }
    }
  });

  test("R10 has 2 arms (R10a and R10b)", () => {
    const r10 = RULE_MANIFEST.rules.find(r => r.rule_id === "R10");
    expect(r10).toBeDefined();
    expect(r10.arms.length).toBe(2);
    expect(r10.arms[0].arm_id).toBe("R10a");
    expect(r10.arms[1].arm_id).toBe("R10b");
  });

  test("extern rules: R3, R8, R13, R14, R15, R16, R17", () => {
    const EXTERN_IDS = ["R3", "R8", "R13", "R14", "R15", "R16", "R17"];
    for (const id of EXTERN_IDS) {
      const rule = RULE_MANIFEST.rules.find(r => r.rule_id === id);
      expect(rule, `${id} should be in RULE_MANIFEST`).toBeDefined();
      expect(rule.extern, `${id} should be extern`).toBe(true);
    }
  });

  test("compiled rules: R1, R2, R4", () => {
    for (const id of ["R1", "R2", "R4"]) {
      const rule = RULE_MANIFEST.rules.find(r => r.rule_id === id);
      expect(rule, `${id} should be in RULE_MANIFEST`).toBeDefined();
      expect(rule.extern, `${id} should NOT be extern`).toBe(false);
    }
  });

  test("src.file is 'beliefs/rules.dl' for all rules", () => {
    for (const rule of RULE_MANIFEST.rules) {
      expect(rule.src.file).toBe("beliefs/rules.dl");
    }
  });

  test("src.line is a positive integer for all rules", () => {
    for (const rule of RULE_MANIFEST.rules) {
      expect(rule.src.line).toBeGreaterThan(0);
    }
  });
});

// ── 6. arms[].sql trim-equals executed STRATA constants ──────────────────────

describe("arms[].sql matches STRATA SQL", () => {
  // Build a flat map of arm_id → sql from GENERATED_STRATA
  const strataIndex = new Map();
  for (const stratum of GENERATED_STRATA) {
    for (const [armId, sql] of stratum) {
      strataIndex.set(armId, sql);
    }
  }

  test("every arm's sql trim-equals the GENERATED_STRATA entry", () => {
    for (const rule of RULE_MANIFEST.rules) {
      for (const arm of rule.arms) {
        const strataSQL = strataIndex.get(arm.arm_id);
        if (strataSQL !== undefined) {
          expect(arm.sql).toBe(strataSQL.trim());
        }
      }
    }
  });
});

// ── 7. R4.negates and R4.cfg_keys ─────────────────────────────────────────────

describe("R4 derived fields", () => {
  test("R4.negates = ['turn_started', 'worker_dead']", () => {
    const r4 = RULE_MANIFEST.rules.find(r => r.rule_id === "R4");
    expect(r4.negates).toContain("turn_started");
    expect(r4.negates).toContain("worker_dead");
    expect(r4.negates.length).toBe(2);
  });

  test("R4.cfg_keys = ['never_started_ms']", () => {
    const r4 = RULE_MANIFEST.rules.find(r => r.rule_id === "R4");
    expect(r4.cfg_keys).toEqual(["never_started_ms"]);
  });

  test("R4.feeds = ['R10']", () => {
    const r4 = RULE_MANIFEST.rules.find(r => r.rule_id === "R4");
    expect(r4.feeds).toContain("R10");
  });

  test("R4.severity = 'warn'", () => {
    const r4 = RULE_MANIFEST.rules.find(r => r.rule_id === "R4");
    expect(r4.severity).toBe("warn");
  });
});

// ── 8. Object.isFrozen(RULE_MANIFEST) ────────────────────────────────────────

describe("RULE_MANIFEST is frozen", () => {
  test("top-level object is frozen", () => {
    expect(Object.isFrozen(RULE_MANIFEST)).toBe(true);
  });

  test("strata array is frozen", () => {
    expect(Object.isFrozen(RULE_MANIFEST.strata)).toBe(true);
  });

  test("rules array is frozen", () => {
    expect(Object.isFrozen(RULE_MANIFEST.rules)).toBe(true);
  });

  test("individual rule objects are frozen", () => {
    for (const rule of RULE_MANIFEST.rules) {
      expect(Object.isFrozen(rule), `rule ${rule.rule_id} should be frozen`).toBe(true);
    }
  });

  test("individual arm objects are frozen", () => {
    for (const rule of RULE_MANIFEST.rules) {
      for (const arm of rule.arms) {
        expect(Object.isFrozen(arm), `arm ${arm.arm_id} should be frozen`).toBe(true);
      }
    }
  });
});

// ── Additional annotations checks ────────────────────────────────────────────

describe("annotation coverage", () => {
  test("R15.cfg_keys contains eligible_state", () => {
    const r15 = RULE_MANIFEST.rules.find(r => r.rule_id === "R15");
    expect(r15.cfg_keys).toContain("eligible_state");
  });

  test("R8.cfg_keys contains max_parallel and session_cap", () => {
    const r8 = RULE_MANIFEST.rules.find(r => r.rule_id === "R8");
    expect(r8.cfg_keys).toContain("max_parallel");
    expect(r8.cfg_keys).toContain("session_cap");
  });

  test("R5.cfg_keys contains lease_window_doc_ms and lease_window_build_ms", () => {
    const r5 = RULE_MANIFEST.rules.find(r => r.rule_id === "R5");
    expect(r5.cfg_keys).toContain("lease_window_doc_ms");
    expect(r5.cfg_keys).toContain("lease_window_build_ms");
  });

  test("R1.cfg_keys is empty", () => {
    const r1 = RULE_MANIFEST.rules.find(r => r.rule_id === "R1");
    expect(r1.cfg_keys).toEqual([]);
  });

  test("R10.cfg_keys contains diag_cooldown_ms", () => {
    const r10 = RULE_MANIFEST.rules.find(r => r.rule_id === "R10");
    expect(r10.cfg_keys).toContain("diag_cooldown_ms");
  });

  test("all rules have non-empty since and ticket", () => {
    for (const rule of RULE_MANIFEST.rules) {
      expect(rule.since, `${rule.rule_id}.since should be set`).toBeTruthy();
      expect(rule.ticket, `${rule.rule_id}.ticket should be set`).toBeTruthy();
    }
  });
});
