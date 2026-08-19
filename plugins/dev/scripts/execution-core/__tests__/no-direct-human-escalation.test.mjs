// no-direct-human-escalation.test.mjs — CTL-2000 Phase 4. The cross-cutting
// guardrail: NO ladder outcome is a direct-human target, for any steward state
// and any page count. "An instrument that reaches the human directly is a
// defect" (routing.md) — this proves the router makes that defect
// unconstructible. Run from execution-core/ under `bun test`.
import { test, expect } from "bun:test";
import { TARGET, nextEscalationTarget } from "../escalation-router.mjs";

test("no ladder outcome is a direct-human target — for any steward state and page count", () => {
  for (const steward of [null, { role: "s", scope: "x" }]) {
    for (const priorPages of [0, 1, 2, 5]) {
      const t = nextEscalationTarget({ scope: "x", priorPages, resolveSteward: () => steward });
      expect([TARGET.STEWARD, TARGET.CONCIERGE, TARGET.ASK]).toContain(t.target);
    }
  }
});

test("TARGET carries no direct-human member — absence is the invariant", () => {
  expect(TARGET.HUMAN_DIRECT).toBeUndefined();
  expect(Object.values(TARGET)).not.toContain("human");
});

test("the human is reachable only via ASK — never returned directly by the ladder", () => {
  // Exhaustive over a wide page-count sweep and both steward states: the router
  // only ever yields STEWARD or CONCIERGE (ASK is the concierge's own next hop,
  // filed by hand). It can never yield a human.
  const outcomes = new Set();
  for (const steward of [null, { role: "s", scope: "x" }]) {
    for (let p = 0; p <= 50; p++) {
      outcomes.add(nextEscalationTarget({ scope: "x", priorPages: p, resolveSteward: () => steward }).target);
    }
  }
  for (const o of outcomes) {
    expect([TARGET.STEWARD, TARGET.CONCIERGE, TARGET.ASK]).toContain(o);
  }
});
