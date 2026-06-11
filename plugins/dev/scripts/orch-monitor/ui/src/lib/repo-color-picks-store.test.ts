import { describe, expect, it, mock } from "bun:test";

// jotai/utils is not installed in the test environment; must be mocked before
// any dynamic import of the store module.
await mock.module("jotai/utils", () => ({ atomWithStorage: () => null }));

const { resolveEffectiveColor, applyColorPick, NAMED_COLOR_NAMES } =
  await import("./repo-color-picks-store");

describe("resolveEffectiveColor", () => {
  it("prefers a valid local pick over the server default", () => {
    expect(resolveEffectiveColor("blue", "purple")).toBe("purple");
  });
  it("falls back to the server default when there is no pick", () => {
    expect(resolveEffectiveColor("blue", undefined)).toBe("blue");
  });
  it("ignores a stale/unknown pick and falls back to the server default", () => {
    expect(resolveEffectiveColor("blue", "chartreuse")).toBe("blue");
  });
  it("returns null when neither server nor pick resolves", () => {
    expect(resolveEffectiveColor(undefined, undefined)).toBeNull();
    expect(resolveEffectiveColor(undefined, "nope")).toBeNull();
  });
  it("exposes the canonical palette as the picker's option source", () => {
    expect(NAMED_COLOR_NAMES).toEqual([
      "blue", "green", "purple", "amber", "red", "teal", "cyan", "lime",
    ]);
  });
});

describe("applyColorPick", () => {
  it("sets a hue for a repo", () => {
    expect(applyColorPick({}, "owner/a", "purple")).toEqual({ "owner/a": "purple" });
  });
  it("deletes the entry when 'auto' is chosen (inherit server default)", () => {
    expect(applyColorPick({ "owner/a": "purple" }, "owner/a", "auto")).toEqual({});
  });
  it("ignores empty/falsy values (deselect no-op)", () => {
    const prev = { "owner/a": "purple" };
    expect(applyColorPick(prev, "owner/a", "")).toBe(prev);
  });
});
