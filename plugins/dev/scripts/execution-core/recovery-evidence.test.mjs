// recovery-evidence.test.mjs — CTL-1241: tests for buildRecoveryItems helper.
//
// Verifies that belief state is correctly attached to recovery evidence items
// when getBeliefs returns a belief, and omitted when it does not.
//
// Run: cd plugins/dev/scripts/execution-core && bun test recovery-evidence.test.mjs

import { describe, test, expect } from "bun:test";
import { buildRecoveryItems } from "./recovery-evidence.mjs";

describe("buildRecoveryItems (CTL-1241)", () => {
  const sig = (ticket, raw = {}) => ({ ticket, phase: "implement", raw });

  test("attaches beliefState when getBeliefs returns a belief", () => {
    const belief = { escalate_human: true, why: "R10+R11 co-occur", subject: "CTL-1/implement", tickId: 5 };
    const items = buildRecoveryItems(
      [sig("CTL-1", { bg_job_id: "abc123" })],
      { getBeliefs: (_db, ticket) => (ticket === "CTL-1" ? belief : null) }
    );
    expect(items).toHaveLength(1);
    expect(items[0].evidence.beliefState).toEqual(belief);
    expect(items[0].evidence.bg_job_id).toBe("abc123"); // raw fields preserved
    expect(items[0].bgJobId).toBe("abc123");
  });

  test("does NOT attach beliefState when getBeliefs returns null", () => {
    const items = buildRecoveryItems(
      [sig("CTL-2")],
      { getBeliefs: () => null }
    );
    expect(items).toHaveLength(1);
    expect(items[0].evidence.beliefState).toBeUndefined();
  });

  test("handles multiple signals independently", () => {
    const belief = { escalate_human: true, why: "R12", subject: "CTL-1/triage", tickId: 1 };
    const items = buildRecoveryItems(
      [sig("CTL-1"), sig("CTL-2")],
      { getBeliefs: (_db, ticket) => (ticket === "CTL-1" ? belief : null) }
    );
    expect(items[0].evidence.beliefState).toBeDefined();
    expect(items[1].evidence.beliefState).toBeUndefined();
  });

  test("is a no-op when getBeliefs is omitted (no beliefState ever)", () => {
    const items = buildRecoveryItems([sig("CTL-X")], {});
    expect(items[0].evidence.beliefState).toBeUndefined();
  });

  test("handles null raw gracefully — evidence is {} not null", () => {
    const items = buildRecoveryItems(
      [{ ticket: "CTL-3", phase: "triage", raw: null }],
      { getBeliefs: () => null }
    );
    expect(items[0].evidence).toEqual({});
  });
});
