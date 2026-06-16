// repo-icon-picks-store.test.ts — unit tests for resolveEffectiveIcon and applyIconPick (CTL-997 Phase 3 / CTL-1207).
// No DOM, no React — pure function tests.
import { describe, it, expect } from "bun:test";
import { resolveEffectiveIcon, applyIconPick } from "./repo-icon-picks-store";
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

describe("applyIconPick", () => {
  it("sets a candidate path for the repo", () => {
    expect(applyIconPick({}, "catalyst", ".github/icon.svg"))
      .toEqual({ catalyst: ".github/icon.svg" });
  });
  it("clears the pick when value is 'auto' (inherit default)", () => {
    expect(applyIconPick({ catalyst: ".github/icon.svg" }, "catalyst", "auto"))
      .toEqual({});
  });
  it("is a no-op (same reference) on empty deselect", () => {
    const prev = { catalyst: ".github/icon.svg" };
    expect(applyIconPick(prev, "catalyst", "")).toBe(prev);
  });
  it("does not mutate the previous map", () => {
    const prev = { catalyst: "a.svg" };
    applyIconPick(prev, "catalyst", "b.svg");
    expect(prev).toEqual({ catalyst: "a.svg" });
  });
  it("preserves other repos when setting a pick", () => {
    expect(applyIconPick({ other: "x.svg" }, "catalyst", "logo.svg"))
      .toEqual({ other: "x.svg", catalyst: "logo.svg" });
  });
});
