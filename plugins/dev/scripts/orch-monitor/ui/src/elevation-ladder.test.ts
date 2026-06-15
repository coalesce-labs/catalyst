// elevation-ladder.test.ts — CTL-1033 token CONTRACT test (extends CTL-1013).
// Asserts the SEMANTIC elevation ladder ORDER (chrome < canvas < subtle < card <
// elevated, by perceived lightness) holds in BOTH themes, derived directly from the
// hex values declared in app.css, plus the alias chains (--surface-0 → chrome, etc.).
// This is the gherkin acceptance contract made executable:
//   sidebar/nav (chrome) DARKEST → canvas → lane bands (subtle) → cards → popovers,
//   in dark; chrome-tinted < canvas < subtle < card < elevated in warm-light.
//   --surface-hover is the interaction tint (EXEMPT — darker in light by design).
//
//   cd ui && bun test src/elevation-ladder.test.ts
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(__dirname, "app.css"), "utf8");

/** Relative luminance (sRGB → linear, WCAG) — monotonic in perceived lightness,
 *  good enough to assert ladder ORDER without an oklch dependency. */
function luminance(hex: string): number {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  const lin = (c: number) =>
    c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** Extract a `--var: #hex;` declaration from inside a given selector block. */
function tokenHex(block: string, name: string): string {
  const re = new RegExp(`${name}\\s*:\\s*(#[0-9a-fA-F]{6})\\s*;`);
  const m = block.match(re);
  if (!m) throw new Error(`token ${name} (literal hex) not found in block`);
  return m[1];
}

/** Extract any `--var: <value>;` declaration (value not necessarily a hex). */
function tokenValue(block: string, name: string): string {
  const re = new RegExp(`${name}\\s*:\\s*([^;]+);`);
  const m = block.match(re);
  if (!m) throw new Error(`token ${name} not found in block`);
  return m[1].trim();
}

function selectorBlock(selector: string): string {
  // Grab the balanced { ... } body of the actual RULE (selector immediately
  // followed by optional whitespace + `{`), not a mention inside a comment.
  const re = new RegExp(`${selector.replace(".", "\\.")}\\s*\\{`);
  const m = re.exec(css);
  if (!m) throw new Error(`selector ${selector} not found`);
  const start = m.index;
  const open = css.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") {
      depth--;
      if (depth === 0) return css.slice(open, i + 1);
    }
  }
  throw new Error(`unbalanced block for ${selector}`);
}

const LADDER = [
  "--surface-chrome",
  "--surface-canvas",
  "--surface-subtle",
  "--surface-card",
  "--surface-elevated",
] as const;

describe("CTL-1033 elevation ladder — semantic surfaces stack upward in both themes", () => {
  it("dark: chrome < canvas < subtle < card < elevated (strictly ascending luminance)", () => {
    const dark = selectorBlock(".dark");
    const ls = LADDER.map((t) => luminance(tokenHex(dark, t)));
    for (let i = 1; i < ls.length; i++) {
      expect(ls[i]).toBeGreaterThan(ls[i - 1]);
    }
  });

  it("warm-light: chrome < canvas < subtle < card < elevated (strictly ascending)", () => {
    const light = selectorBlock(":root");
    const ls = LADDER.map((t) => luminance(tokenHex(light, t)));
    for (let i = 1; i < ls.length; i++) {
      expect(ls[i]).toBeGreaterThan(ls[i - 1]);
    }
  });

  it("--surface-hover is present in both themes (interaction token, EXEMPT from order)", () => {
    expect(tokenHex(selectorBlock(".dark"), "--surface-hover")).toMatch(/^#[0-9a-f]{6}$/i);
    expect(tokenHex(selectorBlock(":root"), "--surface-hover")).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it("dark: numeric aliases chain onto the semantic ladder", () => {
    const dark = selectorBlock(".dark");
    expect(tokenValue(dark, "--surface-0")).toBe("var(--surface-chrome)");
    expect(tokenValue(dark, "--surface-1")).toBe("var(--surface-canvas)");
    expect(tokenValue(dark, "--surface-2")).toBe("var(--surface-card)");
    expect(tokenValue(dark, "--surface-3")).toBe("var(--surface-elevated)");
    expect(dark).toContain("--sidebar: var(--surface-0)");
    expect(dark).toContain("--background: var(--surface-1)");
    expect(dark).toContain("--card: var(--surface-2)");
  });

  it("light: numeric aliases chain; --surface-3 stays the literal #ece7dd inset tint", () => {
    const light = selectorBlock(":root");
    expect(tokenValue(light, "--surface-0")).toBe("var(--surface-chrome)");
    expect(tokenValue(light, "--surface-1")).toBe("var(--surface-canvas)");
    expect(tokenValue(light, "--surface-2")).toBe("var(--surface-card)");
    expect(tokenHex(light, "--surface-3")).toBe("#ece7dd");
    expect(light).toContain("--sidebar: var(--surface-0)");
    expect(light).toContain("--background: var(--surface-1)");
    expect(light).toContain("--card: var(--surface-2)");
  });

  it("CTL-1147: --fg-dim and --shadow-tray exist in both :root and .dark", () => {
    const light = selectorBlock(":root");
    const dark = selectorBlock(".dark");
    expect(light).toContain("--fg-dim");
    expect(dark).toContain("--fg-dim");
    expect(light).toContain("--shadow-tray");
    expect(dark).toContain("--shadow-tray");
  });

  it("CTL-1151: board lane(s0) is recessed below canvas(s1), card(s2) elevated above", () => {
    const dark = selectorBlock(".dark");
    const lum = (t: string) => luminance(tokenHex(dark, t));
    expect(lum("--surface-chrome")).toBeLessThan(lum("--surface-canvas")); // lane < canvas
    expect(lum("--surface-card")).toBeGreaterThan(lum("--surface-canvas")); // card > canvas
  });

  it("CTL-1147: warm-light --fg-dim is more recessive (lighter) than --fg-muted on paper", () => {
    const light = selectorBlock(":root");
    expect(luminance(tokenHex(light, "--fg-dim"))).toBeGreaterThan(
      luminance(tokenHex(light, "--fg-muted")),
    );
  });
});
