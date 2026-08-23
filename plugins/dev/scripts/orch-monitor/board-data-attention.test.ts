// CTL-729: unit tests for deriveAttention() — the ONE "needs attention" bucket
// (operator-approved 2026-06-11) that merges the existing waitingOnUser ("waiting
// on you") state with watchdog/ask escalations into a single yellow board
// accent + an Inbox "Needs you" section. deriveAttention is PURE: it takes the
// three already-read signals (the live worker's waitingOnUser bg-job flag, the
// ticket's Linear labels, and the host-local ask marker presence) plus the
// candidate anchor timestamps, and returns { attention, attentionSince }.
//
// Precedence (operator decision): ask wins over waiting-on-you when both
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
      escalationMarker: false,
      waitingSince: "2026-06-11T08:00:00Z",
      escalationSince: null,
    });
    expect(r.attention).toBe("waiting-on-you");
    expect(r.attentionSince).toBe("2026-06-11T08:00:00Z");
  });

  it("a 'ask' label → attention 'ask'", () => {
    const r = deriveAttention({
      waitingOnUser: false,
      labels: ["catalyst-ask"],
      escalationMarker: false,
      waitingSince: null,
      escalationSince: "2026-06-11T09:00:00Z",
    });
    expect(r.attention).toBe("ask");
    expect(r.attentionSince).toBe("2026-06-11T09:00:00Z");
  });

  it("a 'needs-input' label ALSO maps to attention 'ask' (same escalation)", () => {
    const r = deriveAttention({
      waitingOnUser: false,
      labels: ["needs-input"],
      escalationMarker: false,
      waitingSince: null,
      escalationSince: null,
    });
    expect(r.attention).toBe("ask");
  });

  // ⛔ CTL-2161 CONTRACT CHANGE, ASSERTED DELIBERATELY. The host-local escalation
  // once-marker used to raise attention on its own. It no longer does: the marker
  // records that an escalation was PUBLISHED, and for a SYSTEM stall — 41 of the
  // 86 measured items — publishing means "retrying with backoff under the ONE
  // fleet alert", not "a person owes an answer". A marker that still lit the board
  // would rebuild the bin out of on-disk state after the label was deleted.
  it("the host-local escalation marker ALONE does NOT raise attention (CTL-2161)", () => {
    const r = deriveAttention({
      waitingOnUser: false,
      labels: [],
      escalationMarker: true,
      waitingSince: null,
      escalationSince: "2026-06-11T09:30:00Z",
    });
    expect(r.attention).toBeNull();
    expect(r.attentionSince).toBeNull();
  });

  // POSITIVE CONTROL for the case above: the same call with a real ask reason
  // present DOES raise, so the null above is the marker rule and not a broken
  // classifier.
  it("…but the same shape with an ask label raises `ask` (positive control)", () => {
    const r = deriveAttention({
      waitingOnUser: false,
      labels: ["ask/decision"],
      escalationMarker: true,
      waitingSince: null,
      escalationSince: "2026-06-11T09:30:00Z",
    });
    expect(r.attention).toBe("ask");
    expect(r.attentionSince).toBe("2026-06-11T09:30:00Z");
  });

  it("ask WINS over waiting-on-you when BOTH are present (precedence)", () => {
    const r = deriveAttention({
      waitingOnUser: true,
      labels: ["catalyst-ask"],
      escalationMarker: false,
      waitingSince: "2026-06-11T08:00:00Z",
      escalationSince: "2026-06-11T09:00:00Z",
    });
    expect(r.attention).toBe("ask");
    // the anchor follows the WINNING reason (ask), not the waiting anchor.
    expect(r.attentionSince).toBe("2026-06-11T09:00:00Z");
  });

  // CTL-2161: with the marker no longer a source, a bare marker + a live blocked
  // bg job resolves to waiting-on-you — the reason that is actually true.
  it("a bare escalation marker leaves waiting-on-you standing", () => {
    const r = deriveAttention({
      waitingOnUser: true,
      labels: [],
      escalationMarker: true,
      waitingSince: "2026-06-11T08:00:00Z",
      escalationSince: null,
    });
    expect(r.attention).toBe("waiting-on-you");
    expect(r.attentionSince).toBe("2026-06-11T08:00:00Z");
  });

  it("nothing flagged → attention null, attentionSince null", () => {
    const r = deriveAttention({
      waitingOnUser: false,
      labels: ["enhancement", "orchestrator"],
      escalationMarker: false,
      waitingSince: null,
      escalationSince: null,
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
      escalationMarker: false,
      waitingSince: null,
      escalationSince: null,
    });
    expect(r.attention).toBeNull();
  });

  it("is robust to a non-array labels value (null / undefined → no throw, null attention)", () => {
    expect(deriveAttention({ waitingOnUser: false, labels: null, escalationMarker: false }).attention).toBeNull();
    expect(deriveAttention({ waitingOnUser: false, labels: undefined, escalationMarker: false }).attention).toBeNull();
  });

  it("waiting-on-you with no waitingSince anchor → attention set, attentionSince null (honest, never fabricated)", () => {
    const r = deriveAttention({
      waitingOnUser: true,
      labels: [],
      escalationMarker: false,
      waitingSince: null,
      escalationSince: null,
    });
    expect(r.attention).toBe("waiting-on-you");
    expect(r.attentionSince).toBeNull();
  });

  // CTL-1158: PR-stuck attention signal
  it("a stuck PR (prStuck) → attention 'ask' anchored at prStuckSince", () => {
    const r = deriveAttention({
      waitingOnUser: false,
      labels: [],
      escalationMarker: false,
      prStuck: true,
      prStuckSince: "2026-06-14T10:00:00Z",
    });
    expect(r.attention).toBe("ask");
    expect(r.attentionSince).toBe("2026-06-14T10:00:00Z");
  });

  it("an explicit ask label OUTRANKS prStuck for the anchor (label stamp wins)", () => {
    const r = deriveAttention({
      waitingOnUser: false,
      labels: ["catalyst-ask"],
      escalationMarker: false,
      escalationSince: "2026-06-14T09:00:00Z",
      prStuck: true,
      prStuckSince: "2026-06-14T10:00:00Z",
    });
    expect(r.attention).toBe("ask");
    expect(r.attentionSince).toBe("2026-06-14T09:00:00Z");
  });

  it("prStuck OUTRANKS a live waiting-on-you bg job (escalation precedence)", () => {
    const r = deriveAttention({
      waitingOnUser: true,
      labels: [],
      escalationMarker: false,
      waitingSince: "2026-06-14T08:00:00Z",
      prStuck: true,
      prStuckSince: "2026-06-14T10:00:00Z",
    });
    expect(r.attention).toBe("ask");
    expect(r.attentionSince).toBe("2026-06-14T10:00:00Z");
  });

  it("prStuck:false leaves existing behavior unchanged (back-compat)", () => {
    const r = deriveAttention({ waitingOnUser: false, labels: [], escalationMarker: false });
    expect(r.attention).toBeNull();
    expect(r.attentionSince).toBeNull();
  });
});
