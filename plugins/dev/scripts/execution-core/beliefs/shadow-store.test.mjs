// shadow-store.test.mjs — CTL-935 Phase 1: the shared shadow_comparison writer.
// Tests: insert, JSON encoding, idempotence (INSERT OR IGNORE), and the
// shadow failure contract (a throwing db NEVER propagates).
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { openBeliefsDb } from "./schema.mjs";
import { recordShadowComparison } from "./shadow-store.mjs";

const tmps = [];
function scratch() {
  const d = mkdtempSync(join(tmpdir(), "ctl935-shadow-store-"));
  tmps.push(d);
  return d;
}
let db;
beforeEach(() => {
  db = openBeliefsDb({ path: join(scratch(), "b.db") });
  db.run("INSERT INTO tick (now_ms, host) VALUES (1000, 'mini')");
});
afterEach(() => {
  try { db.close(); } catch { /* */ }
  while (tmps.length) {
    try { rmSync(tmps.pop(), { recursive: true, force: true }); } catch { /* */ }
  }
});

const TICK = 1;

describe("recordShadowComparison — basic insert", () => {
  test("inserts exactly one row with the expected field values", () => {
    recordShadowComparison(db, {
      tickId: TICK,
      dimension: "advance",
      subject: "CTL-722",
      agree: 0,
      procedural: "review",
      belief: "remediate",
      differingInput: { verdict: "fail" },
      ruleId: "R16",
      rulesSha: "abc123",
    });
    const rows = db.query("SELECT * FROM shadow_comparison").all();
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r.tick_id).toBe(TICK);
    expect(r.dimension).toBe("advance");
    expect(r.subject).toBe("CTL-722");
    expect(r.agree).toBe(0);
    expect(r.procedural).toBe("review");
    expect(r.belief).toBe("remediate");
    expect(JSON.parse(r.differing_input)).toEqual({ verdict: "fail" });
    expect(r.rule_id).toBe("R16");
    expect(r.rules_sha).toBe("abc123");
  });

  test("object-valued procedural/belief are JSON-encoded; json_extract reads back the numeric value", () => {
    recordShadowComparison(db, {
      tickId: TICK,
      dimension: "free_slots",
      subject: "host:mini",
      agree: 0,
      procedural: { free_slots: 4, by_lease: 4, by_session_cap: 9 },
      belief: { free_slots: 6, by_lease: 6, by_session_cap: 9 },
      differingInput: { name: "max_parallel" },
      ruleId: "R8",
    });
    const r = db.query(
      "SELECT json_extract(procedural,'$.free_slots') AS ps, json_extract(belief,'$.free_slots') AS bs FROM shadow_comparison",
    ).get();
    expect(r.ps).toBe(4);
    expect(r.bs).toBe(6);
  });

  test("legacyGuard is stored in legacy_guard column", () => {
    recordShadowComparison(db, {
      tickId: TICK,
      dimension: "reclaim",
      subject: "CTL-657/implement",
      agree: 0,
      procedural: "alive-suppressed",
      belief: "worker_dead",
      differingInput: { reason: "job-terminal" },
      legacyGuard: "alive-suppressed",
      ruleId: "R7",
    });
    const r = db.query("SELECT legacy_guard FROM shadow_comparison").get();
    expect(r.legacy_guard).toBe("alive-suppressed");
  });
});

describe("recordShadowComparison — idempotence", () => {
  test("calling twice with same (tickId,dimension,subject) yields one row (INSERT OR IGNORE)", () => {
    const rec = { tickId: TICK, dimension: "advance", subject: "CTL-1", agree: 1, ruleId: "R16" };
    recordShadowComparison(db, rec);
    recordShadowComparison(db, rec);
    expect(db.query("SELECT COUNT(*) AS n FROM shadow_comparison").get().n).toBe(1);
  });
});

describe("recordShadowComparison — shadow failure contract", () => {
  test("a throwing fake db handle does NOT propagate (returns falsey)", () => {
    const badDb = { prepare: () => { throw new Error("db broke"); } };
    let result;
    expect(() => {
      result = recordShadowComparison(badDb, {
        tickId: 1, dimension: "advance", subject: "CTL-X", agree: 0,
      });
    }).not.toThrow();
    expect(result).toBeFalsy();
  });

  test("null db returns 0 without throwing", () => {
    expect(() => {
      const r = recordShadowComparison(null, { tickId: 1, dimension: "advance", subject: "s", agree: 1 });
      expect(r).toBeFalsy();
    }).not.toThrow();
  });
});
