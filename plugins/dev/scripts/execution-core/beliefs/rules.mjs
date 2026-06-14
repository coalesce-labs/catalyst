// beliefs/rules.mjs — CTL-934 belief-store Step 1: the 12 stratified Datalog
// rules (R1–R12) hand-compiled to parameterized SQL over the CTL-933 fact
// schema, with mandatory provenance (rule_id + source_fact_ids) on every
// derived belief row. Behavior-neutral SHADOW: nothing gates on beliefs.
//
// Spec: thoughts/shared/research/2026-06-09-belief-store-step1-datalog.md
//   §2 time model (now is a per-tick fact; recency = arithmetic guard; windows
//       are cfg facts; "no X within window" = stratified negation)
//   §3 the 12 rules in Datalog, 4 strata
//   §4 the SQL compilation pattern (the R4 exemplar is reproduced verbatim
//       below as the canonical shape every rule follows)
//
// ── Stratification ──────────────────────────────────────────────────────────
//   S1 ground correlations           R1 R2 R3 R7   (read obs_* only)
//   S2 liveness verdicts             R4 R5 R6 R9   (negation over S1 beliefs)
//   S3 capacity aggregation          R8            (aggregate over S2 + obs_agent)
//   S4 escalation ladder             R10 R11 R12   (negation over intent)
//   S5 recursive dependency beliefs  R13 R14 R15   (read obs_relation + obs_linear
//                                                   EDB only; intra-stratum reads)
//   S6 FSM advancement prediction    R16 R17       (read obs_signal + obs_verdict
//                                                   + obs_cycle EDB + FSM maps;
//                                                   derive-only — see CTL-966)
//
// No recursion crosses a negation. Each stratum's statements read only the
// strata strictly below it (and the obs_* EDB), so when an S2 rule's NOT EXISTS
// queries belief WHERE name='turn_started', every S1 belief for the tick has
// ALREADY been inserted — the complete-lower-stratum invariant the tests pin.
//
// S5 (CTL-965) is recursive over obs_relation alone (transitive blocker
// closure via WITH RECURSIVE) and contains NO negation over any belief — it
// reads only the obs_relation + obs_linear EDB. It is placed BELOW nothing that
// negates it (no rule in S1–S4 references blocker_rank/cycle_detected/ready), so
// there is no negation cycle: the recursion is confined inside each statement's
// own CTE, and the only cross-statement reads (R15 ready may reference the
// transitive closure shape) stay within obs_relation. Termination is guaranteed
// by UNION (not UNION ALL) in the CTE — the working set dedupes, so even a cyclic
// graph (A→B→A) halts once the (A,A)/(B,B) closure pairs stop being new.
//
// Provenance contract (spec §4): source_fact_ids is a json_array of the
// fact_id / belief_id refs the rule actually consumed, built INSIDE the SELECT
// with json_array(...). Run as constants with a single bound :tick parameter
// (no SQL string concatenation).
//
// REF TAGGING (deviation from spec §4's bare integers — see PR body): belief_id,
// the per-table obs_* fact_id, the tick_id, and the intent_id are SEPARATE
// AUTOINCREMENT spaces that all start at 1, so a bare integer ref is ambiguous
// (belief #1 vs obs_signal fact #1 vs tick #1 — they genuinely collide, and the
// §5 CTE silently mis-resolves them). EACH obs_* table ALSO has its own
// AUTOINCREMENT space, so a generic 'fact' tag would still collide
// (obs_signal#1 vs obs_agent#1). Refs are therefore TAGGED with a one-char
// kind prefix, per source TABLE, so the trace is unambiguous and deterministic:
//   b belief   t tick   i intent
//   s obs_signal   a obs_agent   j obs_job   r obs_transcript
//   h obs_heartbeat   l obs_linear   x obs_relation   (x = CTL-965 S5 dep rules)
//   v obs_verdict   c obs_cycle   (CTL-966 S6 advancement rules)
// json_array values become these tagged TEXT tokens; why.mjs maps prefix→table.
//
// Subject convention:
//   per-phase beliefs   →  ticket || '/' || phase     (e.g. 'CTL-722/plan')
//   capacity beliefs    →  'host:' || host            (e.g. 'host:mini')
//   advancement beliefs →  ticket                     (e.g. 'CTL-722')   (CTL-966)

// All rules are compiled from beliefs/rules.dl by beliefs/compile-rules.mjs.
// Phase 3: R5,R6,R7,R9,R10a,R10b,R11,R12 migrated to extern blocks in rules.dl.
// Regenerate: cd plugins/dev/scripts/execution-core && bun beliefs/compile-rules.mjs
import {
  R1_session_registered,
  R2_turn_started,
  R3_progress_evidence,
  R4_wedged_never_started,
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

// CTL-1063 Phase 4: re-export RULES_SHA so consumers (collector.mjs, tests)
// can import it without a direct dependency on rules.generated.mjs.
// CTL-1063 Phase 5: re-export RULE_MANIFEST so consumers can import it here.
export { RULES_SHA, RULE_MANIFEST } from "./rules.generated.mjs";

// R3 progress_evidence — imported from rules.generated.mjs (extern block in rules.dl).

// R7 worker_dead — imported from rules.generated.mjs (extern block in rules.dl).

// ── Stratum 2: liveness verdicts (stratified negation over S1) ───────────────
// R4 wedged_never_started is compiled from beliefs/rules.dl (imported above).

// R5 lease_valid — imported from rules.generated.mjs (extern block in rules.dl).

// R6 lease_expired — imported from rules.generated.mjs (extern block in rules.dl).

// R9 board_drift — imported from rules.generated.mjs (extern block in rules.dl).

// ── Stratum 3: capacity aggregation ─────────────────────────────────────────
// R8 free_slots — imported from rules.generated.mjs (extern block in rules.dl).

// ── Stratum 4: escalation ladder (stratified negation over intent) ───────────
// R10a, R10b, R11, R12 — imported from rules.generated.mjs (extern blocks in rules.dl).

// ── Stratum 5: recursive dependency beliefs (CTL-965 belief-store Step 2) ─────
// R13, R14, R15 — imported from rules.generated.mjs (extern blocks in rules.dl).

// ── Stratum 6: FSM advancement prediction (CTL-966) ──────────────────────────
// R16, R17 — imported from rules.generated.mjs (extern blocks in rules.dl).
// NOTE: R16 and R17 in rules.generated.mjs were compiled from the extern blocks
// in rules.dl which have the FSM values baked in (matching phase-fsm.mjs at
// the time compile-rules.mjs was run). The advance-rules-fsm-drift.test.mjs
// pins these byte-equal to the live FSM declarations.

// Exported for the FSM-drift guard (advance-rules.test.mjs): asserts the compiled
// rank/next-phase maps stay byte-equal to the live phase-fsm.mjs declarations.
export const R16_advance_to_SQL_FOR_TEST = R16_advance_to;

// STRATA — the run order. Each inner array is one stratum; statements within a
// stratum run in array order (R6 after R5; R10b after R10a) so same-stratum
// negation sees the complete lower set. The tick loop runs strata in order
// inside the existing transaction.
export const STRATA = [
  // S1 ground correlations
  [
    ["R1", R1_session_registered],
    ["R2", R2_turn_started],
    ["R3", R3_progress_evidence],
    ["R7", R7_worker_dead],
  ],
  // S2 liveness verdicts (negation over S1)
  [
    ["R4", R4_wedged_never_started],
    ["R5", R5_lease_valid],
    ["R6", R6_lease_expired],
    ["R9", R9_board_drift],
  ],
  // S3 capacity aggregation
  [["R8", R8_free_slots]],
  // S4 escalation ladder (negation over intent)
  [
    ["R10a", R10a_wake_diagnostician],
    ["R10b", R10b_wake_diagnostician_stalled_alive],
    ["R11", R11_action_ineffective],
    ["R12", R12_escalate_human],
  ],
  // S5 recursive dependency beliefs (read obs_relation + obs_linear EDB only;
  // no negation over any belief, so no negation cycle — see header)
  [
    ["R13", R13_blocker_rank],
    ["R14", R14_cycle_detected],
    ["R15", R15_ready],
  ],
  // S6 FSM advancement prediction (CTL-966) — reads obs_signal + obs_verdict +
  // obs_cycle EDB + the FSM maps only; no negation over any belief, independent
  // of liveness (S1–S5 never reference advance_to/cycle_exhausted), so no
  // negation cycle. DERIVE-ONLY: a prediction, never a dispatch/reset/Linear write.
  [
    ["R16", R16_advance_to],
    ["R17", R17_cycle_exhausted],
  ],
];

// CFG_SEED additions the rules need beyond schema.mjs's CFG_SEED. openBeliefsDb
// seeds the schema set; evaluateBeliefs INSERT OR IGNOREs these so an existing
// db gains them without clobbering operator-tuned values.
export const RULE_CFG_SEED = [
  ["diag_cooldown_ms", 600000], // 10m — wake-diagnostician cooldown (CTL-638)
  ["max_attempts", 2], // R11 — 2 ineffective attempts → escalate (CTL stop-storm)
];

// CTL-965 — R15 ready needs the eligible Linear state as a fact. Seeded into
// cfg.value_text (not value_int). Default 'Todo' = the daemon's code-default
// eligible status (CTL-731; 'Ready' removed 2026-06-02). Operator-tunable like
// every other cfg. Seeded separately because RULE_CFG_SEED's loop binds
// value_int; this loop binds value_text.
export const RULE_CFG_SEED_TEXT = [["eligible_state", "Todo"]];

// evaluateBeliefs — run all four strata over ONE tick, inside the caller's
// transaction. Pure given the tick row's facts (no clock read; recency uses
// tick.now_ms via the SQL). Returns { inserted } counts per rule_id for the
// shadow-comparison log. NEVER opens/commits/rolls back — the collector owns
// the transaction so facts + beliefs land atomically.
export function evaluateBeliefs(db, tickId) {
  // Ensure rule-only cfg exists (idempotent; never clobbers tuned values).
  const seed = db.prepare("INSERT OR IGNORE INTO cfg (key, value_int) VALUES (?, ?)");
  for (const [key, valueInt] of RULE_CFG_SEED) seed.run(key, valueInt);
  // CTL-965 — text-valued cfg (eligible_state) seeded via value_text.
  const seedText = db.prepare("INSERT OR IGNORE INTO cfg (key, value_text) VALUES (?, ?)");
  for (const [key, valueText] of RULE_CFG_SEED_TEXT) seedText.run(key, valueText);

  const inserted = {};
  for (const stratum of STRATA) {
    for (const [ruleId, sql] of stratum) {
      const before = db.query("SELECT COUNT(*) AS n FROM belief WHERE tick_id = ?").get(tickId).n;
      db.query(sql).run({ ":tick": tickId });
      const after = db.query("SELECT COUNT(*) AS n FROM belief WHERE tick_id = ?").get(tickId).n;
      inserted[ruleId] = after - before;
    }
  }
  return { inserted };
}
