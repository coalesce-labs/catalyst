// recovery-evidence.test.mjs — CTL-1241: tests for buildRecoveryItems helper.
//
// Verifies that belief state is correctly attached to recovery evidence items
// when getBeliefs returns a belief, and omitted when it does not.
//
// Run: cd plugins/dev/scripts/execution-core && bun test recovery-evidence.test.mjs

import { describe, test, expect } from "bun:test";
import { buildRecoveryItems } from "./recovery-evidence.mjs";
import { defaultClassifyTicket } from "./recovery-reasoning.mjs";

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

  test("handles null raw gracefully — evidence carries signal:null, no raw fields", () => {
    const items = buildRecoveryItems(
      [{ ticket: "CTL-3", phase: "triage", raw: null }],
      { getBeliefs: () => null }
    );
    // CTL-1299: a missing signal file yields signal:null (falsy → classifier's
    // early-return guard still treats it as "no signal"), and no spurious raw fields.
    expect(items[0].evidence).toEqual({ signal: null });
  });
});

// ─── CTL-1299: evidence.signal starvation fix ────────────────────────────────
//
// The bounded-LLM FIX rung was structurally dead in production: buildRecoveryItems
// spread the raw signal at the TOP level of evidence, but classifyTicket /
// checkBoundedLlmFixes read `evidence.signal.{failureReason,stalledReason}` →
// always undefined → every stalled ticket collapsed to escalate-only. The CTL-1241
// tests above passed because they only checked top-level fields; the regression
// lived in the GAP between buildRecoveryItems' output shape and what the classifier
// reads. These tests close that gap by feeding the REAL buildRecoveryItems output
// to the production classifier — the test that would have caught the prod-dead bug.
describe("buildRecoveryItems → classifier (CTL-1299 — evidence.signal)", () => {
  // production signal shape: readWorkerSignals attaches the full signal-file JSON
  // as `sig.raw`. A stalled/failed worker carries failureReason/stalledReason there.
  const prodSig = (ticket, raw) => ({ ticket, phase: raw.phase ?? "pr", raw });

  test("evidence.signal carries the raw signal (failureReason/stalledReason resolvable)", () => {
    const raw = { bg_job_id: "job-1", phase: "pr", status: "stalled", stalledReason: "source_conflict_ctl708_unavailable" };
    const items = buildRecoveryItems([prodSig("CTL-A", raw)], {});
    expect(items[0].evidence.signal).toBeDefined();
    expect(items[0].evidence.signal.stalledReason).toBe("source_conflict_ctl708_unavailable");
    // top-level spread is retained (back-compat for the deterministic-reason path)
    expect(items[0].evidence.stalledReason).toBe("source_conflict_ctl708_unavailable");
    expect(items[0].evidence.bg_job_id).toBe("job-1");
  });

  test("a source-conflict stall classifies as bounded-llm FIX (not escalate)", () => {
    const raw = { bg_job_id: "job-2", phase: "pr", status: "stalled", stalledReason: "source_conflict_ctl708_unavailable" };
    const items = buildRecoveryItems([prodSig("CTL-B", raw)], {});
    const classification = defaultClassifyTicket(items[0].evidence);
    expect(classification.decision).toBe("fix");
    expect(classification.fix_class).toBe("bounded-llm");
    // the brief (generateRemediateBrief output) is what drives phase-remediate —
    // guard against a future change that wires the signal but degrades the brief.
    expect(typeof classification.details.brief).toBe("string");
    expect(classification.details.brief.length).toBeGreaterThan(0);
  });

  test("a merge-conflict failure classifies as bounded-llm FIX (not escalate)", () => {
    const raw = { bg_job_id: "job-3", phase: "pr", status: "failed", failureReason: "merge-conflict" };
    const items = buildRecoveryItems([prodSig("CTL-C", raw)], {});
    const classification = defaultClassifyTicket(items[0].evidence);
    expect(classification.decision).toBe("fix");
    expect(classification.fix_class).toBe("bounded-llm");
    expect(typeof classification.details.brief).toBe("string");
    expect(classification.details.brief.length).toBeGreaterThan(0);
  });

  test("back-compat: a deterministic-seam reason still classifies as fix via top-level failureReason", () => {
    // checkDeterministicErrors reads evidence.failureReason (top-level) — the
    // top-level spread must survive the fix.
    const raw = { bg_job_id: "job-4", phase: "pr", status: "failed", failureReason: "orphan-sweep-stale" };
    const items = buildRecoveryItems([prodSig("CTL-D", raw)], {});
    const classification = defaultClassifyTicket(items[0].evidence);
    expect(classification.decision).toBe("fix");
    expect(classification.fix_class).toBe("orphan_stale");
  });

  test("a stall with no recognizable reason still escalates (fix does not over-fire)", () => {
    const raw = { bg_job_id: "job-5", phase: "implement", status: "needs-human", failureReason: "design-decision-required" };
    const items = buildRecoveryItems([prodSig("CTL-E", raw)], {});
    const classification = defaultClassifyTicket(items[0].evidence);
    expect(classification.decision).toBe("escalate");
  });
});
