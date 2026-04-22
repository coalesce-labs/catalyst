import { describe, it, expect } from "vitest";
import {
  colorAccent,
  colorBg,
  spacing4,
  radiusMd,
  motionEasingStandard,
  tokens,
} from "../index";

describe("@catalyst/tokens generated exports", () => {
  it("exposes every token as a var(--…) reference, never a raw value", () => {
    for (const value of Object.values(flatten(tokens))) {
      expect(value).toMatch(/^var\(--[a-z0-9-]+\)$/);
    }
  });

  it("aligns named consts with the nested tokens tree", () => {
    expect(colorAccent).toBe("var(--color-accent)");
    expect(colorAccent).toBe(tokens.color.accent);
    expect(colorBg).toBe(tokens.color.bg);
    expect(spacing4).toBe(tokens.spacing["4"]);
    expect(radiusMd).toBe(tokens.radius.md);
    expect(motionEasingStandard).toBe(tokens.motion.easing.standard);
  });

  it("exposes the full color canvas ladder in the color group", () => {
    const keys = Object.keys(tokens.color);
    for (const k of [
      "bg",
      "surface-1",
      "surface-2",
      "surface-3",
      "border-subtle",
      "border-default",
      "border-strong",
      "text-hi",
      "text-md",
      "text-lo",
      "text-disabled",
      "accent",
      "success",
      "warning",
      "danger",
      "info",
    ]) {
      expect(keys).toContain(k);
    }
  });
});

function flatten(node: unknown, out: Record<string, string> = {}, prefix = "") {
  if (typeof node === "string") {
    out[prefix] = node;
    return out;
  }
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      flatten(v, out, prefix ? `${prefix}.${k}` : k);
    }
  }
  return out;
}
