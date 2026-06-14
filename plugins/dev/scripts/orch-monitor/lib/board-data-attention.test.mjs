// board-data-attention.test.mjs — CTL-1131: durable needsHumanSince age anchor.
// Tests deriveNeedsHumanSince (new) and the attentionSince projection through
// deriveAttention (which already accepts needsHumanSince; the fix is the call site).
//
//   cd plugins/dev/scripts/orch-monitor && bun test lib/board-data-attention.test.mjs

import { describe, it, expect } from "bun:test";
import { deriveNeedsHumanSince, deriveAttention } from "./board-data.mjs";

describe("CTL-1131: deriveNeedsHumanSince", () => {
  it("returns needsHumanSince from the newest signal carrying it", () => {
    const sigs = [
      { status: "running" },
      { status: "needs-input", needsHumanSince: "2026-06-14T16:00:00Z" },
    ];
    expect(deriveNeedsHumanSince(sigs)).toBe("2026-06-14T16:00:00Z");
  });

  it("scans newest-first — highest-index stamp wins", () => {
    const sigs = [
      { needsHumanSince: "2026-06-14T10:00:00Z" },
      { needsHumanSince: "2026-06-14T12:00:00Z" },
    ];
    expect(deriveNeedsHumanSince(sigs)).toBe("2026-06-14T12:00:00Z");
  });

  it("returns null when no signal carries needsHumanSince", () => {
    expect(deriveNeedsHumanSince([{ status: "stalled" }])).toBeNull();
  });

  it("returns null for an empty array", () => {
    expect(deriveNeedsHumanSince([])).toBeNull();
  });

  it("ignores non-object entries and non-string stamps without throwing", () => {
    expect(deriveNeedsHumanSince([null, 42, { needsHumanSince: 123 }])).toBeNull();
  });

  it("ignores empty-string stamps (treats them as absent)", () => {
    expect(deriveNeedsHumanSince([{ needsHumanSince: "" }])).toBeNull();
  });
});

describe("CTL-1131: deriveAttention projects needsHumanSince as attentionSince", () => {
  it("uses needsHumanSince as attentionSince when needs-human wins", () => {
    const r = deriveAttention({
      needsHumanMarker: true,
      needsHumanSince: "2026-06-14T16:00:00Z",
    });
    expect(r).toEqual({ attention: "needs-human", attentionSince: "2026-06-14T16:00:00Z" });
  });

  it("attentionSince is null when needsHumanSince is absent", () => {
    const r = deriveAttention({ needsHumanMarker: true });
    expect(r).toEqual({ attention: "needs-human", attentionSince: null });
  });
});
