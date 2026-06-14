// rulebook-live.test.ts — CTL-1103 Phase 4: pure selectors for the live
// Rulebook margin data derived from BeliefsState. No DOM. Run from ui/:
//   cd ui && bun test src/lib/rulebook-live.test.ts
import { describe, it, expect } from "bun:test";
import {
  countFiringByRule,
  subjectsForRule,
} from "./rulebook-live";
import { EMPTY_BELIEFS_STATE, type BeliefStore } from "./beliefs-model";
import type { BeliefFrame } from "./beliefs-model";

// ── fixture helpers ───────────────────────────────────────────────────────────

let _seq = 1;
function makeFrame(rule_id: string, subject: string): BeliefFrame {
  const id = _seq++;
  return {
    belief_id: id,
    tick_id: 1,
    rule_id,
    name: rule_id.toLowerCase(),
    subject,
    value: null,
    source_fact_ids: "[]",
    stratum: 1,
    ts_ms: null,
    host: null,
    rules_sha: null,
  };
}

function makeStore(
  entries: Array<{ rule_id: string; subject: string }>,
): BeliefStore {
  const store: BeliefStore = new Map();
  for (const e of entries) {
    const frame = makeFrame(e.rule_id, e.subject);
    const key = `${frame.rule_id} ${frame.subject}`;
    store.set(key, frame);
  }
  return store;
}

// ── countFiringByRule ─────────────────────────────────────────────────────────

describe("countFiringByRule", () => {
  it("groups store entries by rule_id", () => {
    const store = makeStore([
      { rule_id: "R1", subject: "CTL-1/plan" },
      { rule_id: "R1", subject: "CTL-2/plan" },
      { rule_id: "R6", subject: "CTL-3/impl" },
    ]);
    const counts = countFiringByRule(store);
    expect(counts.get("R1")).toBe(2);
    expect(counts.get("R6")).toBe(1);
  });

  it("returns an empty map for the empty store (recording off)", () => {
    expect(countFiringByRule(EMPTY_BELIEFS_STATE.store).size).toBe(0);
  });

  it("handles a store with a single entry", () => {
    const store = makeStore([{ rule_id: "R5", subject: "CTL-99/verify" }]);
    expect(countFiringByRule(store).get("R5")).toBe(1);
  });

  it("maps arm rule_ids R10a/R10b to logical R10", () => {
    const store = makeStore([
      { rule_id: "R10a", subject: "CTL-1/plan" },
      { rule_id: "R10b", subject: "CTL-2/plan" },
    ]);
    const counts = countFiringByRule(store);
    expect(counts.get("R10")).toBe(2);
    // arm ids should not appear as top-level keys
    expect(counts.has("R10a")).toBe(false);
    expect(counts.has("R10b")).toBe(false);
  });
});

// ── subjectsForRule ───────────────────────────────────────────────────────────

describe("subjectsForRule", () => {
  it("returns subjects for a given rule_id", () => {
    const store = makeStore([
      { rule_id: "R1", subject: "CTL-1/plan" },
      { rule_id: "R1", subject: "CTL-2/plan" },
      { rule_id: "R6", subject: "CTL-3/impl" },
    ]);
    expect(subjectsForRule(store, "R1")).toEqual(["CTL-1/plan", "CTL-2/plan"]);
  });

  it("returns an empty array for a rule with no firing subjects", () => {
    const store = makeStore([{ rule_id: "R1", subject: "CTL-1/plan" }]);
    expect(subjectsForRule(store, "R99")).toEqual([]);
  });

  it("resolves arm rule_ids (R10a→R10) when querying by logical id", () => {
    const store = makeStore([
      { rule_id: "R10a", subject: "CTL-1/plan" },
      { rule_id: "R10b", subject: "CTL-2/plan" },
    ]);
    const subjects = subjectsForRule(store, "R10");
    expect(subjects).toContain("CTL-1/plan");
    expect(subjects).toContain("CTL-2/plan");
  });

  it("returns empty array from empty store", () => {
    expect(subjectsForRule(EMPTY_BELIEFS_STATE.store, "R1")).toEqual([]);
  });
});
