// CTL-1180: unit tests for the phaseFailed + escalationType inputs to
// deriveAttention, the TERMINAL_FAILURE set, and the deriveEscalationType helper.
// A self-emitted failed phase on a NOT-done ticket surfaces as
// attention:"needs-human" — the same path stalled phases already take. A ticket
// that failed but later genuinely shipped (Done) must never appear as needs-human
// (false-positive guard). assembleBoard is not unit-testable (WORKERS_DIR is a
// homedir const) — the call-site logic is covered here via the exported pure
// functions it composes from.

import { describe, it, expect } from "bun:test";

const {
  deriveAttention,
  TERMINAL_FAILURE,
  PIPELINE_DONE_PHASE,
  deriveEscalationType,
  deriveCurrentPhase,
} = await import("./lib/board-data.mjs");

// ── TERMINAL_FAILURE set ──────────────────────────────────────────────────────

describe("TERMINAL_FAILURE set (CTL-1180)", () => {
  it("contains 'failed'", () => {
    expect(TERMINAL_FAILURE.has("failed")).toBe(true);
  });
  it("contains 'stalled'", () => {
    expect(TERMINAL_FAILURE.has("stalled")).toBe(true);
  });
  it("does not contain 'done' or 'skipped' (those are not needs-human)", () => {
    expect(TERMINAL_FAILURE.has("done")).toBe(false);
    expect(TERMINAL_FAILURE.has("skipped")).toBe(false);
  });
  it("does not contain 'canceled' or 'superseded'", () => {
    expect(TERMINAL_FAILURE.has("canceled")).toBe(false);
    expect(TERMINAL_FAILURE.has("superseded")).toBe(false);
  });
});

// ── deriveAttention — phaseFailed + escalationType inputs ─────────────────────

describe("deriveAttention — phaseFailed (CTL-1180)", () => {
  it("phaseFailed:true → attention:'needs-human'", () => {
    const r = deriveAttention({ phaseFailed: true });
    expect(r.attention).toBe("needs-human");
  });

  it("phaseFailed:true + escalationType → both on the result", () => {
    const r = deriveAttention({ phaseFailed: true, escalationType: "authorization" });
    expect(r.attention).toBe("needs-human");
    expect(r.escalationType).toBe("authorization");
  });

  it("phaseFailed:false with no other trigger → attention:null", () => {
    const r = deriveAttention({ phaseFailed: false });
    expect(r.attention).toBeNull();
  });

  it("phaseFailed does not override needsHumanSince anchor (anchor precedence unchanged)", () => {
    const r = deriveAttention({
      phaseFailed: true,
      needsHumanSince: "2026-06-15T10:00:00Z",
    });
    expect(r.attention).toBe("needs-human");
    expect(r.attentionSince).toBe("2026-06-15T10:00:00Z");
  });

  it("{} (no args) still returns attention:null, escalationType:null (back-compat)", () => {
    const r = deriveAttention({});
    expect(r.attention).toBeNull();
    expect(r.escalationType).toBeNull();
  });

  it("phaseFailed:true wins over waiting-on-you (escalation precedence)", () => {
    const r = deriveAttention({ waitingOnUser: true, phaseFailed: true });
    expect(r.attention).toBe("needs-human");
  });

  it("escalationType is null when not provided (not a failed-phase source)", () => {
    const r = deriveAttention({ labels: ["needs-human"] });
    expect(r.escalationType).toBeNull();
  });

  it("all three return branches include the escalationType key", () => {
    const needs = deriveAttention({ labels: ["needs-human"] });
    const waiting = deriveAttention({ waitingOnUser: true });
    const none = deriveAttention({});
    expect("escalationType" in needs).toBe(true);
    expect("escalationType" in waiting).toBe(true);
    expect("escalationType" in none).toBe(true);
  });

  it("existing needs-human label + phaseFailed both → still needs-human", () => {
    const r = deriveAttention({ labels: ["needs-human"], phaseFailed: true });
    expect(r.attention).toBe("needs-human");
  });
});

// ── deriveEscalationType helper ───────────────────────────────────────────────

describe("deriveEscalationType (CTL-1180)", () => {
  it("returns escalation_type from the newest signal that has one", () => {
    const phaseSigs = [
      { status: "done", explanation: null },
      {
        status: "failed",
        explanation: { escalation_type: "authorization", call_to_action: "fix auth" },
      },
    ];
    expect(deriveEscalationType(phaseSigs)).toBe("authorization");
  });

  it("returns null when no signal has explanation.escalation_type", () => {
    const phaseSigs = [
      { status: "failed", explanation: { call_to_action: "do something" } },
    ];
    expect(deriveEscalationType(phaseSigs)).toBeNull();
  });

  it("scans newest-first (last element in array wins)", () => {
    const phaseSigs = [
      { status: "failed", explanation: { escalation_type: "old_type" } },
      { status: "failed", explanation: { escalation_type: "new_type" } },
    ];
    expect(deriveEscalationType(phaseSigs)).toBe("new_type");
  });

  it("handles empty array gracefully", () => {
    expect(deriveEscalationType([])).toBeNull();
  });

  it("handles null/non-object signals gracefully (no throw)", () => {
    expect(deriveEscalationType([null, undefined, 42])).toBeNull();
  });
});

// ── Call-site derivation logic — phaseFailed gated on NOT pipeline-done ───────
// assembleBoard is not unit-testable (WORKERS_DIR hardcoded), so we verify the
// call-site guard logic using the pure exported constants + deriveCurrentPhase.

describe("phaseFailed call-site logic (CTL-1180 false-positive guard)", () => {
  // Simulate: phase-pr.json status:failed, no pipeline completion
  it("failed phase + pipeline NOT done → phaseFailed should be true", () => {
    const phaseSigs = [
      { status: "done" },   // triage
      { status: "done" },   // research
      { status: "done" },   // plan
      { status: "done" },   // implement
      { status: "done" },   // verify
      { status: "done" },   // review
      { status: "failed" }, // pr
    ];
    const cur = deriveCurrentPhase(phaseSigs);
    const phaseFailed =
      cur.phase !== PIPELINE_DONE_PHASE &&
      phaseSigs.some((s) => s && TERMINAL_FAILURE.has(s.status));
    expect(phaseFailed).toBe(true);
  });

  // Simulate: phase-pr.json status:failed AND teardown status:done
  it("failed phase + pipeline IS done (teardown done) → phaseFailed must be false", () => {
    // PHASE_ORDER: triage(0) research(1) plan(2) implement(3) verify(4) review(5)
    //              pr(6) monitor-merge(7) monitor-deploy(8) teardown(9)
    const phaseSigs = [
      { status: "done" },   // 0: triage
      { status: "done" },   // 1: research
      { status: "done" },   // 2: plan
      { status: "done" },   // 3: implement
      { status: "done" },   // 4: verify
      { status: "done" },   // 5: review
      { status: "failed" }, // 6: pr
      { status: "done" },   // 7: monitor-merge
      { status: "done" },   // 8: monitor-deploy
      { status: "done" },   // 9: teardown (PHASE_ORDER.length - 1)
    ];
    const cur = deriveCurrentPhase(phaseSigs);
    // deriveCurrentPhase collapses a terminal teardown to PIPELINE_DONE_PHASE
    const phaseFailed =
      cur.phase !== PIPELINE_DONE_PHASE &&
      phaseSigs.some((s) => s && TERMINAL_FAILURE.has(s.status));
    expect(phaseFailed).toBe(false);
  });

  it("no failed/stalled phase → phaseFailed is false", () => {
    const phaseSigs = [
      { status: "done" },
      { status: "done" },
      { status: "running" },
    ];
    const cur = deriveCurrentPhase(phaseSigs);
    const phaseFailed =
      cur.phase !== PIPELINE_DONE_PHASE &&
      phaseSigs.some((s) => s && TERMINAL_FAILURE.has(s.status));
    expect(phaseFailed).toBe(false);
  });
});
