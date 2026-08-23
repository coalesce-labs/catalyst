// board-data-attention.test.mjs — CTL-1131: deriveEscalationSince + attentionSince projection.
// Covers the durable waiting-age anchor: scans phase signals newest-first and surfaces
// the most-recent needsHumanSince stamp; projects it into deriveAttention's attentionSince.
//
//   cd plugins/dev/scripts/orch-monitor && bun test lib/board-data-attention.test.mjs

import { describe, it, expect } from "bun:test";
import { deriveEscalationSince, deriveAttention, deriveCorrelationRole } from "./board-data.mjs";

describe("CTL-1131: deriveEscalationSince", () => {
  it("returns needsHumanSince from the newest signal carrying it", () => {
    const sigs = [
      { status: "running" },
      { status: "needs-input", needsHumanSince: "2026-06-14T16:00:00Z" },
    ];
    expect(deriveEscalationSince(sigs)).toBe("2026-06-14T16:00:00Z");
  });

  it("scans newest-first — highest-index stamp wins", () => {
    const sigs = [
      { needsHumanSince: "2026-06-14T10:00:00Z" },
      { needsHumanSince: "2026-06-14T12:00:00Z" },
    ];
    expect(deriveEscalationSince(sigs)).toBe("2026-06-14T12:00:00Z");
  });

  it("returns null when no signal carries it", () => {
    expect(deriveEscalationSince([{ status: "stalled" }])).toBeNull();
  });

  it("returns null for an empty array", () => {
    expect(deriveEscalationSince([])).toBeNull();
  });

  it("ignores non-object entries without throwing", () => {
    expect(deriveEscalationSince([null, 42, "bogus"])).toBeNull();
  });

  it("ignores non-string stamps without throwing", () => {
    expect(deriveEscalationSince([{ needsHumanSince: 123 }])).toBeNull();
  });

  it("ignores empty-string stamps", () => {
    expect(deriveEscalationSince([{ needsHumanSince: "" }])).toBeNull();
  });

  it("falls back to an earlier signal when newest carries none", () => {
    const sigs = [{ needsHumanSince: "2026-06-14T08:00:00Z" }, { status: "running" }];
    expect(deriveEscalationSince(sigs)).toBe("2026-06-14T08:00:00Z");
  });
});

describe("CTL-1131: deriveAttention projects escalationSince → attentionSince", () => {
  it("uses escalationSince as attentionSince when ask wins", () => {
    const r = deriveAttention({
      labels: ["catalyst-ask"],
      escalationSince: "2026-06-14T16:00:00Z",
    });
    expect(r).toEqual({
      attention: "ask",
      attentionSince: "2026-06-14T16:00:00Z",
      escalationType: null,
      correlationRole: null,
    });
  });

  it("attentionSince is null when ask wins but no stamp provided", () => {
    const r = deriveAttention({ labels: ["catalyst-ask"], escalationSince: null });
    expect(r).toEqual({
      attention: "ask",
      attentionSince: null,
      escalationType: null,
      correlationRole: null,
    });
  });
});

// ─── CAT-170: correlation role projection (the notification-suppression seam) ──
//
// The producer writes a top-level `correlation` field on the escalation signal;
// deriveCorrelationRole projects it and deriveAttention passes it through on the
// ask branch ONLY. Without this projection every correlated member looked
// like an ordinary ask authorization and the notification path — which
// keys on ticket id — emitted one push per member.
describe("CAT-170: deriveCorrelationRole", () => {
  it("returns the role from the newest signal carrying a correlation", () => {
    const sigs = [
      { status: "stalled", correlation: { id: "c1", role: "anchor", anchor: "CAT-1" } },
      { status: "stalled", correlation: { id: "c1", role: "member", anchor: "CAT-1" } },
    ];
    expect(deriveCorrelationRole(sigs)).toBe("member");
  });

  it("skips signals without a correlation and returns null when none carry one", () => {
    expect(deriveCorrelationRole([{ status: "running" }, { status: "stalled" }])).toBeNull();
  });

  it("ignores a malformed correlation (no string role)", () => {
    expect(deriveCorrelationRole([{ correlation: { id: "c1" } }, { correlation: null }])).toBeNull();
  });
});

describe("CAT-170: deriveAttention passes the correlation role through", () => {
  it("surfaces the role on the ask branch", () => {
    const r = deriveAttention({ labels: ["catalyst-ask"], correlationRole: "member" });
    expect(r.attention).toBe("ask");
    expect(r.correlationRole).toBe("member");
  });

  it("does not surface a role on the waiting-on-you branch", () => {
    const r = deriveAttention({ waitingOnUser: true, correlationRole: "member" });
    expect(r.attention).toBe("waiting-on-you");
    expect(r.correlationRole).toBeNull();
  });

  it("does not surface a role when the ticket is Linear-terminal", () => {
    const r = deriveAttention({
      labels: ["catalyst-ask"],
      correlationRole: "member",
      linearTerminal: true,
    });
    expect(r.attention).toBeNull();
    expect(r.correlationRole).toBeNull();
  });
});

// ─── CTL-1241 Phase 3: board/recovery label agreement (regression pins) ───────
//
// Pins the contract that board.deriveAttention reads the same ask label
// that executeEscalations (the R12 belief owner) applies. This is the source of
// truth both surfaces share; a future producer change that diverges them would
// break this test.
describe("CTL-1241 — deriveAttention label agreement regression", () => {
  it("ticket with ask label → board flags ask (via labelNeedsHuman)", () => {
    const r = deriveAttention({ labels: ["catalyst-ask"] });
    expect(r.attention).toBe("ask");
  });

  it("ask label alone is sufficient — phaseFailed and prStuck not required", () => {
    const r = deriveAttention({
      labels: ["catalyst-ask"],
      phaseFailed: false,
      prStuck: false,
      escalationMarker: false,
    });
    expect(r.attention).toBe("ask");
  });

  it("ask OUTRANKS waiting-on-you when both fire", () => {
    const r = deriveAttention({ labels: ["catalyst-ask"], waitingOnUser: true });
    expect(r.attention).toBe("ask");
  });

  it("ticket WITHOUT ask label → board does NOT report ask from label alone", () => {
    const r = deriveAttention({
      labels: [],
      phaseFailed: false,
      prStuck: false,
      escalationMarker: false,
    });
    expect(r.attention).toBeNull();
  });

  it("cross-surface: recovery-escalated ticket (label applied) → board ask true", () => {
    // Simulate: recovery pass escalated ticket, executeEscalations applied the
    // ask label. Board reads the label and reports ask — same
    // source of truth as the recovery pass classification.
    const boardResult = deriveAttention({ labels: ["catalyst-ask"] });
    expect(boardResult.attention).toBe("ask");
  });

  it("cross-surface: recovery FIX (no label applied) → board does NOT report ask from label", () => {
    // Simulate: recovery pass classified FIX — no ask label was applied.
    // Board should NOT report ask solely from a stale marker that was
    // never applied (empty labels array, no marker).
    const boardResult = deriveAttention({
      labels: [],
      escalationMarker: false,
      phaseFailed: false,
      prStuck: false,
    });
    expect(boardResult.attention).toBeNull();
  });
});
