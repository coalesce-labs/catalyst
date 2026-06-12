// beliefs/compiler-equivalence.test.mjs — CTL-1063 Phase 2+3: stale-file guard.
// Verifies that the committed rules.generated.mjs constants are byte-equivalent
// (after .trim()) to what the compiler produces from rules.dl.
// CI gate: if someone edits rules.dl without regenerating, this fails.
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { compile, EXTERN_RULE_IDS, PENDING_INLINE_IDS } from "./compiler/index.mjs";
import {
  R1_session_registered,
  R2_turn_started,
  R4_wedged_never_started,
  R3_progress_evidence,
  R5_lease_valid,
  R6_lease_expired,
  R7_worker_dead,
  R8_free_slots,
  R9_board_drift,
  R10a_wake_diagnostician,
  R10b_wake_diagnostician_stalled_alive,
  R11_action_ineffective,
  R12_escalate_human,
  R13_blocker_rank,
  R14_cycle_detected,
  R15_ready,
  R16_advance_to,
  R17_cycle_exhausted,
  GENERATED_STRATA,
} from "./rules.generated.mjs";
import { STRATA } from "./rules.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dlSource = readFileSync(resolve(__dirname, "rules.dl"), "utf8");

// Phase 1: compiled rule IDs
const COMPILED_IDS = ["R1", "R2", "R4"];

// Phase 2: extern rule IDs (original)
// Phase 3: adds R5,R6,R7,R9,R10a,R10b,R11,R12
const EXTERN_IDS = [
  "R3", "R5", "R6", "R7", "R8", "R9",
  "R10a", "R10b", "R11", "R12",
  "R13", "R14", "R15", "R16", "R17",
];

// Committed constants for compiled rules (Phase 1)
const COMMITTED_COMPILED = new Map([
  ["R1", R1_session_registered],
  ["R2", R2_turn_started],
  ["R4", R4_wedged_never_started],
]);

// Committed constants for extern rules (Phase 2+3)
const COMMITTED_EXTERN = new Map([
  ["R3", R3_progress_evidence],
  ["R5", R5_lease_valid],
  ["R6", R6_lease_expired],
  ["R7", R7_worker_dead],
  ["R8", R8_free_slots],
  ["R9", R9_board_drift],
  ["R10a", R10a_wake_diagnostician],
  ["R10b", R10b_wake_diagnostician_stalled_alive],
  ["R11", R11_action_ineffective],
  ["R12", R12_escalate_human],
  ["R13", R13_blocker_rank],
  ["R14", R14_cycle_detected],
  ["R15", R15_ready],
  ["R16", R16_advance_to],
  ["R17", R17_cycle_exhausted],
]);

describe("compiler-equivalence", () => {

  // ── Phase 1 Test 1: Compiled SQL matches committed constants (stale-file guard) ─

  test("R1: compiler output trim-equals committed constant", () => {
    const result = compile(dlSource);
    expect(result.getRule("R1")).not.toBeNull();
    expect(result.getRule("R1").trim()).toBe(R1_session_registered.trim());
  });

  test("R2: compiler output trim-equals committed constant", () => {
    const result = compile(dlSource);
    expect(result.getRule("R2")).not.toBeNull();
    expect(result.getRule("R2").trim()).toBe(R2_turn_started.trim());
  });

  test("R4: compiler output trim-equals committed constant", () => {
    const result = compile(dlSource);
    expect(result.getRule("R4")).not.toBeNull();
    expect(result.getRule("R4").trim()).toBe(R4_wedged_never_started.trim());
  });

  // ── Phase 2 Test: Extern SQL matches committed constants (verbatim, not skipped) ─

  test("R3: getRule returns extern SQL trim-equal to committed constant", () => {
    const result = compile(dlSource);
    expect(result.getRule("R3")).not.toBeNull();
    expect(result.getRule("R3").trim()).toBe(R3_progress_evidence.trim());
  });

  test("R8: getRule returns extern SQL trim-equal to committed constant", () => {
    const result = compile(dlSource);
    expect(result.getRule("R8")).not.toBeNull();
    expect(result.getRule("R8").trim()).toBe(R8_free_slots.trim());
  });

  test("R13: getRule returns extern SQL trim-equal to committed constant", () => {
    const result = compile(dlSource);
    expect(result.getRule("R13")).not.toBeNull();
    expect(result.getRule("R13").trim()).toBe(R13_blocker_rank.trim());
  });

  test("R14: getRule returns extern SQL trim-equal to committed constant", () => {
    const result = compile(dlSource);
    expect(result.getRule("R14")).not.toBeNull();
    expect(result.getRule("R14").trim()).toBe(R14_cycle_detected.trim());
  });

  test("R15: getRule returns extern SQL trim-equal to committed constant", () => {
    const result = compile(dlSource);
    expect(result.getRule("R15")).not.toBeNull();
    expect(result.getRule("R15").trim()).toBe(R15_ready.trim());
  });

  test("R16: getRule returns extern SQL trim-equal to committed constant", () => {
    const result = compile(dlSource);
    expect(result.getRule("R16")).not.toBeNull();
    expect(result.getRule("R16").trim()).toBe(R16_advance_to.trim());
  });

  test("R17: getRule returns extern SQL trim-equal to committed constant", () => {
    const result = compile(dlSource);
    expect(result.getRule("R17")).not.toBeNull();
    expect(result.getRule("R17").trim()).toBe(R17_cycle_exhausted.trim());
  });

  // ── Phase 2 Test: extern manifest entries ───────────────────────────────────

  test("getManifestEntry('R3').extern === true", () => {
    const result = compile(dlSource);
    expect(result.getManifestEntry("R3")).toBeDefined();
    expect(result.getManifestEntry("R3").extern).toBe(true);
  });

  test("getManifestEntry('R8').extern === true", () => {
    const result = compile(dlSource);
    expect(result.getManifestEntry("R8").extern).toBe(true);
  });

  test("getManifestEntry('R13').extern === true", () => {
    const result = compile(dlSource);
    expect(result.getManifestEntry("R13").extern).toBe(true);
  });

  test("getManifestEntry('R16').extern === true", () => {
    const result = compile(dlSource);
    expect(result.getManifestEntry("R16").extern).toBe(true);
  });

  test("getManifestEntry('R16').stratum === 6", () => {
    const result = compile(dlSource);
    expect(result.getManifestEntry("R16").stratum).toBe(6);
  });

  test("getManifestEntry('R17').stratum === 6", () => {
    const result = compile(dlSource);
    expect(result.getManifestEntry("R17").stratum).toBe(6);
  });

  // ── Phase 2 Test: stratum positions ─────────────────────────────────────────

  test("R3 stratum is 1 (S1)", () => {
    const result = compile(dlSource);
    expect(result.getManifestEntry("R3").stratum).toBe(1);
  });

  test("R8 stratum is 3 (S3)", () => {
    const result = compile(dlSource);
    expect(result.getManifestEntry("R8").stratum).toBe(3);
  });

  test("R13 stratum is 5 (S5)", () => {
    const result = compile(dlSource);
    expect(result.getManifestEntry("R13").stratum).toBe(5);
  });

  test("R14 stratum is 5 (S5)", () => {
    const result = compile(dlSource);
    expect(result.getManifestEntry("R14").stratum).toBe(5);
  });

  test("R15 stratum is 5 (S5)", () => {
    const result = compile(dlSource);
    expect(result.getManifestEntry("R15").stratum).toBe(5);
  });

  // ── Phase 3 Test: EXTERN_RULE_IDS pinned exactly (all 15 extern rules) ─────

  test("EXTERN_RULE_IDS is exactly Phase2+3 extern set (15 rules)", () => {
    expect(EXTERN_RULE_IDS.size).toBe(15);
    for (const id of EXTERN_IDS) {
      expect(EXTERN_RULE_IDS.has(id)).toBe(true);
    }
    // Compiled rules are NOT in EXTERN
    for (const id of COMPILED_IDS) {
      expect(EXTERN_RULE_IDS.has(id)).toBe(false);
    }
  });

  // ── Phase 3 Test: PENDING_INLINE is now empty ────────────────────────────────

  test("PENDING_INLINE_IDS is empty after Phase 3 migration", () => {
    expect(PENDING_INLINE_IDS.size).toBe(0);
    // All extern rules are no longer pending
    for (const id of EXTERN_IDS) {
      expect(PENDING_INLINE_IDS.has(id)).toBe(false);
    }
    // Compiled rules are also not pending
    for (const id of COMPILED_IDS) {
      expect(PENDING_INLINE_IDS.has(id)).toBe(false);
    }
  });

  // ── Phase 1 Test: Coverage ledger (updated for Phase 2) ────────────────────

  test("all COMPILED rules are NOT in PENDING_INLINE_IDS", () => {
    for (const id of COMPILED_IDS) {
      expect(PENDING_INLINE_IDS.has(id)).toBe(false);
    }
  });

  test("all EXTERN rules are NOT in PENDING_INLINE_IDS", () => {
    for (const id of EXTERN_IDS) {
      expect(PENDING_INLINE_IDS.has(id)).toBe(false);
    }
  });

  test("COMPILED ∪ EXTERN ∪ PENDING_INLINE covers all rules in STRATA", () => {
    // Flatten all rule IDs from STRATA
    const strataIds = new Set(STRATA.flatMap((s) => s.map(([id]) => id)));
    const covered = new Set([...COMPILED_IDS, ...EXTERN_IDS, ...PENDING_INLINE_IDS]);
    for (const id of strataIds) {
      expect(covered.has(id)).toBe(true);
    }
  });

  // ── Phase 1+2 Test: GENERATED_STRATA entries trim-match STRATA ──────────────

  test("GENERATED_STRATA entries trim-match STRATA entries for compiled and extern rules", () => {
    // Build a flat map of [ruleId → sql] from STRATA
    const strataMap = new Map(STRATA.flatMap((s) => s));
    // Check each rule in GENERATED_STRATA
    const allHandledIds = new Set([...COMPILED_IDS, ...EXTERN_IDS]);
    for (const stratum of GENERATED_STRATA) {
      for (const [ruleId, compiledSql] of stratum) {
        if (allHandledIds.has(ruleId)) {
          const stratasSql = strataMap.get(ruleId);
          expect(stratasSql).toBeDefined();
          expect(compiledSql.trim()).toBe(stratasSql.trim());
        }
      }
    }
  });

  test("GENERATED_STRATA contains exactly compiled + extern rules", () => {
    const flatIds = GENERATED_STRATA.flatMap((s) => s.map(([id]) => id));
    const allHandledIds = new Set([...COMPILED_IDS, ...EXTERN_IDS]);
    // All compiled and extern IDs should be present
    for (const id of allHandledIds) {
      expect(flatIds).toContain(id);
    }
    // Only handled IDs should be present (no PENDING_INLINE in GENERATED_STRATA)
    for (const id of flatIds) {
      expect(allHandledIds.has(id)).toBe(true);
    }
  });

  // ── Self-test: mutating committed constant causes gate to fail ───────────────

  test("self-test: mutated committed constant does NOT trim-match compiler output", () => {
    const result = compile(dlSource);
    const compiled = result.getRule("R1");
    // Simulate stale committed constant by appending garbage
    const mutated = R1_session_registered + "\n-- stale";
    expect(compiled.trim()).not.toBe(mutated.trim());
  });

  test("self-test: mutated extern constant does NOT trim-match compiler output", () => {
    const result = compile(dlSource);
    const compiled = result.getRule("R3");
    const mutated = R3_progress_evidence + "\n-- stale";
    expect(compiled.trim()).not.toBe(mutated.trim());
  });

  // ── Phase 1 Test: generated constants match STRATA ──────────────────────────

  test("R1_session_registered from rules.generated.mjs equals STRATA R1 entry", () => {
    const strataMap = new Map(STRATA.flatMap((s) => s));
    expect(R1_session_registered.trim()).toBe(strataMap.get("R1").trim());
  });

  test("R2_turn_started from rules.generated.mjs equals STRATA R2 entry", () => {
    const strataMap = new Map(STRATA.flatMap((s) => s));
    expect(R2_turn_started.trim()).toBe(strataMap.get("R2").trim());
  });

  test("R4_wedged_never_started from rules.generated.mjs equals STRATA R4 entry", () => {
    const strataMap = new Map(STRATA.flatMap((s) => s));
    expect(R4_wedged_never_started.trim()).toBe(strataMap.get("R4").trim());
  });

  // ── Phase 2 Test: generated extern constants match STRATA ───────────────────

  test("R3_progress_evidence from rules.generated.mjs equals STRATA R3 entry", () => {
    const strataMap = new Map(STRATA.flatMap((s) => s));
    expect(R3_progress_evidence.trim()).toBe(strataMap.get("R3").trim());
  });

  test("R8_free_slots from rules.generated.mjs equals STRATA R8 entry", () => {
    const strataMap = new Map(STRATA.flatMap((s) => s));
    expect(R8_free_slots.trim()).toBe(strataMap.get("R8").trim());
  });

  test("R13_blocker_rank from rules.generated.mjs equals STRATA R13 entry", () => {
    const strataMap = new Map(STRATA.flatMap((s) => s));
    expect(R13_blocker_rank.trim()).toBe(strataMap.get("R13").trim());
  });

  test("R14_cycle_detected from rules.generated.mjs equals STRATA R14 entry", () => {
    const strataMap = new Map(STRATA.flatMap((s) => s));
    expect(R14_cycle_detected.trim()).toBe(strataMap.get("R14").trim());
  });

  test("R15_ready from rules.generated.mjs equals STRATA R15 entry", () => {
    const strataMap = new Map(STRATA.flatMap((s) => s));
    expect(R15_ready.trim()).toBe(strataMap.get("R15").trim());
  });

  test("R16_advance_to from rules.generated.mjs equals STRATA R16 entry", () => {
    const strataMap = new Map(STRATA.flatMap((s) => s));
    expect(R16_advance_to.trim()).toBe(strataMap.get("R16").trim());
  });

  test("R17_cycle_exhausted from rules.generated.mjs equals STRATA R17 entry", () => {
    const strataMap = new Map(STRATA.flatMap((s) => s));
    expect(R17_cycle_exhausted.trim()).toBe(strataMap.get("R17").trim());
  });

  // ── Phase 3 Tests: R5,R6,R7,R9,R10a,R10b,R11,R12 migrated to extern blocks ──

  test("R5: getRule returns extern SQL trim-equal to committed constant", () => {
    const result = compile(dlSource);
    expect(result.getRule("R5")).not.toBeNull();
    expect(result.getRule("R5").trim()).toBe(R5_lease_valid.trim());
  });

  test("R6: getRule returns extern SQL trim-equal to committed constant", () => {
    const result = compile(dlSource);
    expect(result.getRule("R6")).not.toBeNull();
    expect(result.getRule("R6").trim()).toBe(R6_lease_expired.trim());
  });

  test("R7: getRule returns extern SQL trim-equal to committed constant", () => {
    const result = compile(dlSource);
    expect(result.getRule("R7")).not.toBeNull();
    expect(result.getRule("R7").trim()).toBe(R7_worker_dead.trim());
  });

  test("R9: getRule returns extern SQL trim-equal to committed constant", () => {
    const result = compile(dlSource);
    expect(result.getRule("R9")).not.toBeNull();
    expect(result.getRule("R9").trim()).toBe(R9_board_drift.trim());
  });

  test("R10a: getRule returns extern SQL trim-equal to committed constant", () => {
    const result = compile(dlSource);
    expect(result.getRule("R10a")).not.toBeNull();
    expect(result.getRule("R10a").trim()).toBe(R10a_wake_diagnostician.trim());
  });

  test("R10b: getRule returns extern SQL trim-equal to committed constant", () => {
    const result = compile(dlSource);
    expect(result.getRule("R10b")).not.toBeNull();
    expect(result.getRule("R10b").trim()).toBe(R10b_wake_diagnostician_stalled_alive.trim());
  });

  test("R11: getRule returns extern SQL trim-equal to committed constant", () => {
    const result = compile(dlSource);
    expect(result.getRule("R11")).not.toBeNull();
    expect(result.getRule("R11").trim()).toBe(R11_action_ineffective.trim());
  });

  test("R12: getRule returns extern SQL trim-equal to committed constant", () => {
    const result = compile(dlSource);
    expect(result.getRule("R12")).not.toBeNull();
    expect(result.getRule("R12").trim()).toBe(R12_escalate_human.trim());
  });

  // ── Phase 3 Tests: structural validation ────────────────────────────────────

  test("R6 SQL contains both NOT EXISTS clauses (lease_valid and worker_dead)", () => {
    const result = compile(dlSource);
    const sql = result.getRule("R6");
    expect(sql).toContain("NOT EXISTS");
    expect(sql).toContain("'lease_valid'");
    expect(sql).toContain("'worker_dead'");
  });

  test("R7 CASE ladder is present: job_gone, first_terminal_at, state: prefix", () => {
    const result = compile(dlSource);
    const sql = result.getRule("R7");
    expect(sql).toContain("CASE");
    expect(sql).toContain("'job_gone'");
    expect(sql).toContain("'first_terminal_at'");
    expect(sql).toContain("'state:' ||");
  });

  test("R9 SQL contains UNION ALL inline lookup table (not VALUES)", () => {
    const result = compile(dlSource);
    const sql = result.getRule("R9");
    expect(sql).toContain("UNION ALL");
    expect(sql).toContain("'triage'");
    expect(sql).toContain("'Research'");
    // Should not use VALUES syntax (uses SELECT ... UNION ALL)
    expect(sql).not.toContain("VALUES");
  });

  test("R10a SQL contains rule_id 'R10' literal", () => {
    const result = compile(dlSource);
    const sql = result.getRule("R10a");
    expect(sql).toContain("'R10'");
  });

  test("R10b SQL contains rule_id 'R10' literal", () => {
    const result = compile(dlSource);
    const sql = result.getRule("R10b");
    expect(sql).toContain("'R10'");
  });

  test("R11 SQL contains outcome IS NULL and attempts >= cfg", () => {
    const result = compile(dlSource);
    const sql = result.getRule("R11");
    expect(sql).toContain("outcome IS NULL");
    expect(sql).toContain("attempts >= c.value_int");
  });

  test("R12 SQL contains belief-to-belief join (wake_diagnostician and action_ineffective)", () => {
    const result = compile(dlSource);
    const sql = result.getRule("R12");
    expect(sql).toContain("'wake_diagnostician'");
    expect(sql).toContain("'action_ineffective'");
    expect(sql).toContain("'wake-diagnostician:' ||");
  });

  // ── Phase 3 Tests: STRATA inner-order guarantees ─────────────────────────────

  test("R5 appears before R6 in S2 of GENERATED_STRATA", () => {
    const s2 = GENERATED_STRATA.find((stratum) =>
      stratum.some(([id]) => id === "R5")
    );
    expect(s2).toBeDefined();
    const r5idx = s2.findIndex(([id]) => id === "R5");
    const r6idx = s2.findIndex(([id]) => id === "R6");
    expect(r5idx).toBeLessThan(r6idx);
  });

  test("R10a appears before R10b in S4 of GENERATED_STRATA", () => {
    const s4 = GENERATED_STRATA.find((stratum) =>
      stratum.some(([id]) => id === "R10a")
    );
    expect(s4).toBeDefined();
    const r10aidx = s4.findIndex(([id]) => id === "R10a");
    const r10bidx = s4.findIndex(([id]) => id === "R10b");
    expect(r10aidx).toBeLessThan(r10bidx);
  });

  // ── Phase 3 Tests: PENDING_INLINE empty, STRATA deep-equals GENERATED_STRATA ──

  test("PENDING_INLINE_IDS is empty (all rules migrated)", () => {
    expect(PENDING_INLINE_IDS.size).toBe(0);
  });

  test("STRATA deep-equals GENERATED_STRATA (all rules covered)", () => {
    // STRATA and GENERATED_STRATA should have the same structure and SQL
    expect(STRATA.length).toBe(GENERATED_STRATA.length);
    for (let si = 0; si < STRATA.length; si++) {
      const strataStratum = STRATA[si];
      const genStratum = GENERATED_STRATA[si];
      expect(strataStratum.length).toBe(genStratum.length);
      for (let ri = 0; ri < strataStratum.length; ri++) {
        const [strataId, stratasSql] = strataStratum[ri];
        const [genId, genSql] = genStratum[ri];
        expect(strataId).toBe(genId);
        expect(stratasSql.trim()).toBe(genSql.trim());
      }
    }
  });

  // ── Phase 3 Tests: Phase 3 generated constants match STRATA ─────────────────

  test("R5_lease_valid from rules.generated.mjs equals STRATA R5 entry", () => {
    const strataMap = new Map(STRATA.flatMap((s) => s));
    expect(R5_lease_valid.trim()).toBe(strataMap.get("R5").trim());
  });

  test("R6_lease_expired from rules.generated.mjs equals STRATA R6 entry", () => {
    const strataMap = new Map(STRATA.flatMap((s) => s));
    expect(R6_lease_expired.trim()).toBe(strataMap.get("R6").trim());
  });

  test("R7_worker_dead from rules.generated.mjs equals STRATA R7 entry", () => {
    const strataMap = new Map(STRATA.flatMap((s) => s));
    expect(R7_worker_dead.trim()).toBe(strataMap.get("R7").trim());
  });

  test("R9_board_drift from rules.generated.mjs equals STRATA R9 entry", () => {
    const strataMap = new Map(STRATA.flatMap((s) => s));
    expect(R9_board_drift.trim()).toBe(strataMap.get("R9").trim());
  });

  test("R10a_wake_diagnostician from rules.generated.mjs equals STRATA R10a entry", () => {
    const strataMap = new Map(STRATA.flatMap((s) => s));
    expect(R10a_wake_diagnostician.trim()).toBe(strataMap.get("R10a").trim());
  });

  test("R10b_wake_diagnostician_stalled_alive from rules.generated.mjs equals STRATA R10b entry", () => {
    const strataMap = new Map(STRATA.flatMap((s) => s));
    expect(R10b_wake_diagnostician_stalled_alive.trim()).toBe(strataMap.get("R10b").trim());
  });

  test("R11_action_ineffective from rules.generated.mjs equals STRATA R11 entry", () => {
    const strataMap = new Map(STRATA.flatMap((s) => s));
    expect(R11_action_ineffective.trim()).toBe(strataMap.get("R11").trim());
  });

  test("R12_escalate_human from rules.generated.mjs equals STRATA R12 entry", () => {
    const strataMap = new Map(STRATA.flatMap((s) => s));
    expect(R12_escalate_human.trim()).toBe(strataMap.get("R12").trim());
  });
});
