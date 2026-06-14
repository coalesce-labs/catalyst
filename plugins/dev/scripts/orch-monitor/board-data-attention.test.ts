// CTL-729: unit tests for deriveAttention() — the ONE "needs attention" bucket
// (operator-approved 2026-06-11) that merges the existing waitingOnUser ("waiting
// on you") state with watchdog/needs-human escalations into a single yellow board
// accent + an Inbox "Needs you" section. deriveAttention is PURE: it takes the
// three already-read signals (the live worker's waitingOnUser bg-job flag, the
// ticket's Linear labels, and the host-local needs-human marker presence) plus the
// candidate anchor timestamps, and returns { attention, attentionSince }.
//
// Precedence (operator decision): needs-human wins over waiting-on-you when both
// are present. `held` (the admission-gate blocked/waiting pair) is UNTOUCHED — it
// is a DIFFERENT concept (admission gate) from `attention` (operator action).

import { describe, it, expect } from "bun:test";

// board-data.mjs is plain JS — import dynamically so TS doesn't choke on the path.
const { deriveAttention } = await import("./lib/board-data.mjs");

describe("deriveAttention (CTL-729) — the single needs-attention bucket", () => {
  it("a live worker whose bg job is 'blocked' → attention 'waiting-on-you'", () => {
    const r = deriveAttention({
      waitingOnUser: true,
      labels: [],
      needsHumanMarker: false,
      waitingSince: "2026-06-11T08:00:00Z",
      needsHumanSince: null,
    });
    expect(r.attention).toBe("waiting-on-you");
    expect(r.attentionSince).toBe("2026-06-11T08:00:00Z");
  });

  it("a 'needs-human' label → attention 'needs-human'", () => {
    const r = deriveAttention({
      waitingOnUser: false,
      labels: ["needs-human"],
      needsHumanMarker: false,
      waitingSince: null,
      needsHumanSince: "2026-06-11T09:00:00Z",
    });
    expect(r.attention).toBe("needs-human");
    expect(r.attentionSince).toBe("2026-06-11T09:00:00Z");
  });

  it("a 'needs-input' label ALSO maps to attention 'needs-human' (same escalation)", () => {
    const r = deriveAttention({
      waitingOnUser: false,
      labels: ["needs-input"],
      needsHumanMarker: false,
      waitingSince: null,
      needsHumanSince: null,
    });
    expect(r.attention).toBe("needs-human");
  });

  it("the host-local .linear-label-needs-human.applied marker → 'needs-human' (label fallback)", () => {
    const r = deriveAttention({
      waitingOnUser: false,
      labels: [],
      needsHumanMarker: true,
      waitingSince: null,
      needsHumanSince: "2026-06-11T09:30:00Z",
    });
    expect(r.attention).toBe("needs-human");
    expect(r.attentionSince).toBe("2026-06-11T09:30:00Z");
  });

  it("needs-human WINS over waiting-on-you when BOTH are present (precedence)", () => {
    const r = deriveAttention({
      waitingOnUser: true,
      labels: ["needs-human"],
      needsHumanMarker: false,
      waitingSince: "2026-06-11T08:00:00Z",
      needsHumanSince: "2026-06-11T09:00:00Z",
    });
    expect(r.attention).toBe("needs-human");
    // the anchor follows the WINNING reason (needs-human), not the waiting anchor.
    expect(r.attentionSince).toBe("2026-06-11T09:00:00Z");
  });

  it("marker-driven needs-human ALSO wins over waiting-on-you", () => {
    const r = deriveAttention({
      waitingOnUser: true,
      labels: [],
      needsHumanMarker: true,
      waitingSince: "2026-06-11T08:00:00Z",
      needsHumanSince: null,
    });
    expect(r.attention).toBe("needs-human");
  });

  it("nothing flagged → attention null, attentionSince null", () => {
    const r = deriveAttention({
      waitingOnUser: false,
      labels: ["enhancement", "orchestrator"],
      needsHumanMarker: false,
      waitingSince: null,
      needsHumanSince: null,
    });
    expect(r.attention).toBeNull();
    expect(r.attentionSince).toBeNull();
  });

  it("the held admission-gate labels (blocked/waiting) do NOT trigger attention", () => {
    // `blocked` / `waiting` are the admission-gate pair (heldFor), a DIFFERENT
    // concept from operator-action attention — they must not light the yellow bucket.
    const r = deriveAttention({
      waitingOnUser: false,
      labels: ["blocked", "waiting"],
      needsHumanMarker: false,
      waitingSince: null,
      needsHumanSince: null,
    });
    expect(r.attention).toBeNull();
  });

  it("is robust to a non-array labels value (null / undefined → no throw, null attention)", () => {
    expect(deriveAttention({ waitingOnUser: false, labels: null, needsHumanMarker: false }).attention).toBeNull();
    expect(deriveAttention({ waitingOnUser: false, labels: undefined, needsHumanMarker: false }).attention).toBeNull();
  });

  it("waiting-on-you with no waitingSince anchor → attention set, attentionSince null (honest, never fabricated)", () => {
    const r = deriveAttention({
      waitingOnUser: true,
      labels: [],
      needsHumanMarker: false,
      waitingSince: null,
      needsHumanSince: null,
    });
    expect(r.attention).toBe("waiting-on-you");
    expect(r.attentionSince).toBeNull();
  });

  // CTL-1158: PR-stuck attention signal
  it("a stuck PR (prStuck) → attention 'needs-human' anchored at prStuckSince", () => {
    const r = deriveAttention({
      waitingOnUser: false,
      labels: [],
      needsHumanMarker: false,
      prStuck: true,
      prStuckSince: "2026-06-14T10:00:00Z",
    });
    expect(r.attention).toBe("needs-human");
    expect(r.attentionSince).toBe("2026-06-14T10:00:00Z");
  });

  it("an explicit needs-human label OUTRANKS prStuck for the anchor (label stamp wins)", () => {
    const r = deriveAttention({
      waitingOnUser: false,
      labels: ["needs-human"],
      needsHumanMarker: false,
      needsHumanSince: "2026-06-14T09:00:00Z",
      prStuck: true,
      prStuckSince: "2026-06-14T10:00:00Z",
    });
    expect(r.attention).toBe("needs-human");
    expect(r.attentionSince).toBe("2026-06-14T09:00:00Z");
  });

  it("prStuck OUTRANKS a live waiting-on-you bg job (escalation precedence)", () => {
    const r = deriveAttention({
      waitingOnUser: true,
      labels: [],
      needsHumanMarker: false,
      waitingSince: "2026-06-14T08:00:00Z",
      prStuck: true,
      prStuckSince: "2026-06-14T10:00:00Z",
    });
    expect(r.attention).toBe("needs-human");
    expect(r.attentionSince).toBe("2026-06-14T10:00:00Z");
  });

  it("prStuck:false leaves existing behavior unchanged (back-compat)", () => {
    const r = deriveAttention({ waitingOnUser: false, labels: [], needsHumanMarker: false });
    expect(r.attention).toBeNull();
    expect(r.attentionSince).toBeNull();
  });
});
