// repo-icon-picks-store.test.ts — unit tests for resolveEffectiveIcon (CTL-997 Phase 3).
// No DOM, no React — pure function tests.
import { describe, it, expect } from "bun:test";
import { resolveEffectiveIcon } from "./repo-icon-picks-store";
import type { IconCandidate } from "./repo-icons";

const cands: IconCandidate[] = [
  { path: "logo.svg", format: "svg", downloadUrl: "u1", dataUrl: "data:svg" },
  { path: "favicon.ico", format: "ico", downloadUrl: "u2", dataUrl: "data:ico" },
];

describe("resolveEffectiveIcon", () => {
  it("uses the default best (server selectedPath) when no pick", () => {
    const r = resolveEffectiveIcon(cands, "logo.svg", undefined);
    expect(r).toEqual({ autoDataUrl: "data:svg", selectedPath: "logo.svg" });
  });
  it("honors a valid pick", () => {
    const r = resolveEffectiveIcon(cands, "logo.svg", "favicon.ico");
    expect(r).toEqual({ autoDataUrl: "data:ico", selectedPath: "favicon.ico" });
  });
  it("ignores a stale pick that no longer matches a candidate", () => {
    const r = resolveEffectiveIcon(cands, "logo.svg", "gone.png");
    expect(r).toEqual({ autoDataUrl: "data:svg", selectedPath: "logo.svg" });
  });
  it("returns null icon for no candidates", () => {
    expect(resolveEffectiveIcon([], null, undefined)).toEqual({ autoDataUrl: null, selectedPath: null });
  });
  it("falls back to first candidate when defaultSelectedPath is unknown", () => {
    const r = resolveEffectiveIcon(cands, "missing.svg", undefined);
    expect(r).toEqual({ autoDataUrl: "data:svg", selectedPath: "logo.svg" });
  });
  it("handles null dataUrl in chosen candidate", () => {
    const nullCands: IconCandidate[] = [
      { path: "favicon.ico", format: "ico", downloadUrl: "u", dataUrl: null },
    ];
    const r = resolveEffectiveIcon(nullCands, "favicon.ico", undefined);
    expect(r).toEqual({ autoDataUrl: null, selectedPath: "favicon.ico" });
  });
});
