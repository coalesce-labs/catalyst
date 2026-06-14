// beliefs/compiler/index.test.mjs — CTL-1063 Phase 1: compiler unit tests.
// Tests the tokenize → parse → lower(IR) → emitSql pipeline.
import { describe, test, expect } from "bun:test";
import { compile, EXTERN_RULE_IDS, PENDING_INLINE_IDS } from "./index.mjs";

// ── Helpers ────────────────────────────────────────────────────────────────────

const MINIMAL_SOURCE = `
rule R99 test_belief
stratum 3
subject: s.ticket || '/' || s.phase
:-
  tick t,
  obs_signal s ON s.tick_id = t.tick_id,
  provenance [s:s.fact_id].
`;

const NOT_SOURCE = `
rule R98 negation_test
stratum 2
subject: s.ticket
:-
  tick t,
  obs_signal s ON s.tick_id = t.tick_id,
  not some_belief(s.ticket),
  provenance [s:s.fact_id].
`;

const GUARD_SOURCE = `
rule R97 guard_test
stratum 2
subject: s.ticket
:-
  tick t,
  obs_signal s ON s.tick_id = t.tick_id,
  guard s.started_at_ms IS NOT NULL,
  guard t.now_ms - s.started_at_ms > 100,
  provenance [s:s.fact_id].
`;

const PROVENANCE_SOURCE = `
rule R96 provenance_test
stratum 1
subject: s.ticket || '/' || s.phase
value: json_object('x', a.x)
:-
  tick t,
  obs_signal s ON s.tick_id = t.tick_id,
  obs_agent a ON a.tick_id = t.tick_id AND a.short_id = s.bg_job_id,
  obs_transcript tr ON tr.tick_id = t.tick_id AND tr.session_id = a.session_id,
  provenance [s:s.fact_id, a:a.fact_id, r:tr.fact_id].
`;

const R1_SHAPED_SOURCE = `
rule R1 session_registered
stratum 1
subject: s.ticket || '/' || s.phase
value: json_object('session_id', a.session_id, 'short_id', a.short_id)
:-
  tick t,
  obs_signal s ON s.tick_id = t.tick_id AND s.bg_job_id IS NOT NULL,
  obs_agent a ON a.tick_id = t.tick_id AND a.short_id = s.bg_job_id AND a.kind = 'background',
  provenance [s:s.fact_id, a:a.fact_id].
`;

// ── Test 1: Parse minimal conjunctive clause → clause AST with head.name set ──

describe("compiler", () => {
  test("parse minimal conjunctive clause → IR has correct head fields", () => {
    const result = compile(MINIMAL_SOURCE);
    const entry = result.rules.get("R99");
    expect(entry).toBeDefined();
    const { ir } = entry;
    expect(ir.ruleId).toBe("R99");
    expect(ir.name).toBe("test_belief");
    expect(ir.stratum).toBe(3);
    expect(ir.subjectExpr).toBe("s.ticket || '/' || s.phase");
    expect(ir.valueExpr).toBeNull();
    expect(ir.joins).toHaveLength(2);
    expect(ir.joins[0]).toEqual({ table: "tick", alias: "t", on: null });
    expect(ir.joins[1]).toEqual({
      table: "obs_signal",
      alias: "s",
      on: "s.tick_id = t.tick_id",
    });
    expect(ir.guards).toHaveLength(0);
    expect(ir.negations).toHaveLength(0);
    expect(ir.provenanceRefs).toHaveLength(1);
    expect(ir.provenanceRefs[0]).toEqual({ kind: "s", ref: "s.fact_id" });
  });

  // ── Test 2: NOT body atom lowers to negation IR node ──────────────────────

  test("NOT body atom lowers to negation IR node", () => {
    const result = compile(NOT_SOURCE);
    const { ir } = result.rules.get("R98");
    expect(ir.negations).toHaveLength(1);
    expect(ir.negations[0]).toEqual({ name: "some_belief", subject: "s.ticket" });
    expect(ir.guards).toHaveLength(0);
  });

  // ── Test 3: Guard lowers to guard node ────────────────────────────────────

  test("guard clauses lower to guards array in IR", () => {
    const result = compile(GUARD_SOURCE);
    const { ir } = result.rules.get("R97");
    expect(ir.guards).toHaveLength(2);
    expect(ir.guards[0]).toBe("s.started_at_ms IS NOT NULL");
    expect(ir.guards[1]).toBe("t.now_ms - s.started_at_ms > 100");
    expect(ir.negations).toHaveLength(0);
  });

  // ── Test 4: Provenance spec lowers to IR with tagged refs in declared order ─

  test("provenance spec lowers to tagged refs in declared order", () => {
    const result = compile(PROVENANCE_SOURCE);
    const { ir } = result.rules.get("R96");
    expect(ir.provenanceRefs).toHaveLength(3);
    expect(ir.provenanceRefs[0]).toEqual({ kind: "s", ref: "s.fact_id" });
    expect(ir.provenanceRefs[1]).toEqual({ kind: "a", ref: "a.fact_id" });
    expect(ir.provenanceRefs[2]).toEqual({ kind: "r", ref: "tr.fact_id" });
  });

  // ── Test 5: emitSql for R1-shaped IR ─────────────────────────────────────

  test("emitSql for R1-shaped IR produces canonical INSERT OR IGNORE", () => {
    const result = compile(R1_SHAPED_SOURCE);
    const sql = result.getRule("R1");
    expect(sql).toBeDefined();
    // Must start with INSERT OR IGNORE INTO belief
    expect(sql.trim()).toMatch(/^INSERT OR IGNORE INTO belief/);
    // Must contain FROM tick
    expect(sql).toContain("FROM tick t");
    // Must contain JOIN
    expect(sql).toContain("JOIN obs_signal");
    expect(sql).toContain("JOIN obs_agent");
    // Must contain json_array
    expect(sql).toContain("json_array(");
    // Must end with WHERE t.tick_id = :tick
    expect(sql.trimEnd()).toMatch(/WHERE t\.tick_id = :tick\s*$/);
    // Deterministic: compiling the same source twice yields identical bytes
    const result2 = compile(R1_SHAPED_SOURCE);
    expect(result2.getRule("R1")).toBe(sql);
  });

  // ── Test 6: value column included only when value: is present ─────────────

  test("emitSql includes value column iff value: is declared", () => {
    const withValue = compile(R1_SHAPED_SOURCE).getRule("R1");
    const withoutValue = compile(MINIMAL_SOURCE).getRule("R99");
    // With value: column list has 'value'
    expect(withValue).toContain("subject, value, rule_id");
    // Without value: column list omits 'value'
    expect(withoutValue).not.toContain("subject, value, rule_id");
    expect(withoutValue).toContain("subject, rule_id");
  });

  // ── Test 7: getRule returns null for unknown rule IDs ─────────────────────

  test("getRule returns null for unknown rule IDs", () => {
    const result = compile(R1_SHAPED_SOURCE);
    expect(result.getRule("R99")).toBeNull();
    expect(result.getRule("R3")).toBeNull();
  });

  // ── Test 8: EXTERN_RULE_IDS contains all Phase 2+3 rules ──────────────────

  test("EXTERN_RULE_IDS contains all Phase 2+3 extern rules", () => {
    expect(EXTERN_RULE_IDS).toBeInstanceOf(Set);
    // Phase 2 externs: R3,R8,R13,R14,R15,R16,R17 (7)
    // Phase 3 externs: R5,R6,R7,R9,R10a,R10b,R11,R12 (8)
    expect(EXTERN_RULE_IDS.size).toBe(15);
    for (const id of ["R3", "R5", "R6", "R7", "R8", "R9",
                       "R10a", "R10b", "R11", "R12",
                       "R13", "R14", "R15", "R16", "R17"]) {
      expect(EXTERN_RULE_IDS.has(id)).toBe(true);
    }
  });

  // ── Test 9: PENDING_INLINE_IDS is empty (Phase 3 complete) ───────────────

  test("PENDING_INLINE_IDS is empty after Phase 3 migration", () => {
    expect(PENDING_INLINE_IDS).toBeInstanceOf(Set);
    expect(PENDING_INLINE_IDS.size).toBe(0);
    // All rules now in compiled or extern — none pending
    for (const id of ["R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8", "R9",
                       "R10a", "R10b", "R11", "R12", "R13", "R14", "R15", "R16", "R17"]) {
      expect(PENDING_INLINE_IDS.has(id)).toBe(false);
    }
  });

  // ── Test 10: getGeneratedStrata returns strata grouped by stratum number ──

  test("getGeneratedStrata groups compiled rules by stratum in order", () => {
    const result = compile(R1_SHAPED_SOURCE);
    const strata = result.getGeneratedStrata();
    // R1 is stratum 1 — one stratum with one rule
    expect(strata).toHaveLength(1);
    expect(strata[0]).toHaveLength(1);
    expect(strata[0][0][0]).toBe("R1");
  });
});
