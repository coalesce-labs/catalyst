// board-data-attention.test.mjs — CTL-1131: deriveNeedsHumanSince + attentionSince projection.
// Covers the durable waiting-age anchor: scans phase signals newest-first and surfaces
// the most-recent needsHumanSince stamp; projects it into deriveAttention's attentionSince.
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

  it("returns null when no signal carries it", () => {
    expect(deriveNeedsHumanSince([{ status: "stalled" }])).toBeNull();
  });

  it("returns null for an empty array", () => {
    expect(deriveNeedsHumanSince([])).toBeNull();
  });

  it("ignores non-object entries without throwing", () => {
    expect(deriveNeedsHumanSince([null, 42, "bogus"])).toBeNull();
  });

  it("ignores non-string stamps without throwing", () => {
    expect(deriveNeedsHumanSince([{ needsHumanSince: 123 }])).toBeNull();
  });

  it("ignores empty-string stamps", () => {
    expect(deriveNeedsHumanSince([{ needsHumanSince: "" }])).toBeNull();
  });

  it("falls back to an earlier signal when newest carries none", () => {
    const sigs = [{ needsHumanSince: "2026-06-14T08:00:00Z" }, { status: "running" }];
    expect(deriveNeedsHumanSince(sigs)).toBe("2026-06-14T08:00:00Z");
  });
});

describe("CTL-1131: deriveAttention projects needsHumanSince → attentionSince", () => {
  it("uses needsHumanSince as attentionSince when needs-human wins", () => {
    const r = deriveAttention({
      needsHumanMarker: true,
      needsHumanSince: "2026-06-14T16:00:00Z",
    });
    expect(r).toEqual({ attention: "needs-human", attentionSince: "2026-06-14T16:00:00Z", escalationType: null });
  });

  it("attentionSince is null when needs-human wins but no stamp provided", () => {
    const r = deriveAttention({ needsHumanMarker: true, needsHumanSince: null });
    expect(r).toEqual({ attention: "needs-human", attentionSince: null, escalationType: null });
  });
});
