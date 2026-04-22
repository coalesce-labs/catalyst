import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, "../../dist");

function readIfExists(p: string): string | null {
  try {
    return fs.readFileSync(p, "utf-8");
  } catch {
    return null;
  }
}

describe("@catalyst/tokens build outputs", () => {
  const themeCss = readIfExists(path.join(DIST, "theme.css"));
  const tailwind = readIfExists(path.join(DIST, "tailwind.tokens.js"));
  const tokensDts = readIfExists(path.join(DIST, "generated.d.ts"));

  it("produces all three build artifacts", () => {
    expect(themeCss, "dist/theme.css").not.toBeNull();
    expect(tailwind, "dist/tailwind.tokens.js").not.toBeNull();
    expect(tokensDts, "dist/generated.d.ts").not.toBeNull();
  });

  it("emits both system blocks in theme.css", () => {
    expect(themeCss).toContain(":root");
    expect(themeCss).toContain('[data-system="operator-console"]');
    expect(themeCss).toContain('[data-system="precision-instrument"]');
  });

  it("declares the full operator-console color palette under :root", () => {
    const systemA = themeCss!.split(
      '[data-system="precision-instrument"]',
    )[0] ?? "";
    for (const line of [
      "--color-bg: #07090b",
      "--color-surface-1: #0d1117",
      "--color-surface-2: #131a22",
      "--color-surface-3: #1b242e",
      "--color-border-subtle: #1f2a35",
      "--color-border-default: #2a3845",
      "--color-border-strong: #3c4e5d",
      "--color-text-hi: #e6edf3",
      "--color-text-md: #9aa7b2",
      "--color-text-lo: #5c6b78",
      "--color-text-disabled: #364450",
      "--color-accent: #ffb547",
      "--color-accent-hover: #ffc466",
      "--color-accent-active: #e09520",
      "--color-success: #3fb950",
      "--color-warning: #d29922",
      "--color-danger: #f85149",
      "--color-info: #58a6ff",
    ]) {
      expect(systemA).toContain(line);
    }
  });

  it("overrides the full precision-instrument color palette under [data-system='precision-instrument']", () => {
    const systemB =
      themeCss!.split('[data-system="precision-instrument"]')[1] ?? "";
    for (const line of [
      "--color-bg: #fafaf7",
      "--color-surface-1: #ffffff",
      "--color-surface-2: #f3f3ee",
      "--color-surface-3: #ececE5".toLowerCase(),
      "--color-border-subtle: #e8e7e0",
      "--color-border-default: #d6d4ca",
      "--color-border-strong: #9a978c",
      "--color-text-hi: #16181c",
      "--color-text-md: #3b3e46",
      "--color-text-lo: #6e7078",
      "--color-text-disabled: #a8a8a1",
      "--color-accent: #2c3e64",
      "--color-accent-hover: #1f2e4e",
      "--color-accent-active: #152341",
      "--color-success: #4f6f4a",
      "--color-warning: #a17b2e",
      "--color-danger: #9a3b2c",
      "--color-info: #4a6078",
    ]) {
      expect(systemB).toContain(line);
    }
  });

  it("declares spacing, radius, and motion-fallback tokens in operator-console block", () => {
    const systemA =
      themeCss!.split('[data-system="precision-instrument"]')[0] ?? "";
    for (const line of [
      "--spacing-4: 16px",
      "--spacing-0-5: 2px",
      "--radius-md: 4px",
      "--radius-full: 9999px",
      "--motion-duration-base: 150ms",
      "--motion-duration-heartbeat: 2400ms",
      "--motion-easing-standard: cubic-bezier(0.2, 0, 0, 1)",
    ]) {
      expect(systemA).toContain(line);
    }
  });

  it("declares system-specific motion tokens for precision-instrument", () => {
    const systemB =
      themeCss!.split('[data-system="precision-instrument"]')[1] ?? "";
    for (const line of [
      "--motion-duration-micro: 120ms",
      "--motion-duration-state: 180ms",
      "--motion-duration-reflow: 240ms",
    ]) {
      expect(systemB).toContain(line);
    }
  });

  it("emits no hardcoded hex literals in the Tailwind fragment", () => {
    expect(tailwind).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  it("emits no hardcoded hex literals in the TS declarations", () => {
    expect(tokensDts).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  it("produces Tailwind var(--…) references covering every scale", () => {
    for (const ref of [
      '"var(--color-accent)"',
      '"var(--color-bg)"',
      '"var(--spacing-4)"',
      '"var(--radius-md)"',
      '"var(--motion-duration-base)"',
      '"var(--motion-easing-standard)"',
    ]) {
      expect(tailwind).toContain(ref);
    }
  });

  it("uses no `any` type in the TS declarations", () => {
    expect(tokensDts).not.toMatch(/\bany\b/);
  });
});
