// elevation-ladder.test.ts — CTL-1013 token CONTRACT test.
// Asserts the elevation ladder ORDER (chrome < content < cards, by perceived
// lightness) holds in BOTH themes, derived directly from the hex values declared
// in app.css. This is the gherkin acceptance contract made executable:
//   sidebar/nav (chrome) DARKEST → content canvas one step lighter → cards lighter
//   again, in dark; chrome-tinted < canvas < cards in warm-light.
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

describe("CTL-1013 elevation ladder — surfaces stack upward in both themes", () => {
  it("dark: chrome (s0) < content canvas (s1) < cards (s2) < raised (s3) < hover (s4)", () => {
    const dark = selectorBlock(".dark");
    const s0 = luminance(tokenHex(dark, "--surface-0"));
    const s1 = luminance(tokenHex(dark, "--surface-1"));
    const s2 = luminance(tokenHex(dark, "--surface-2"));
    const s3 = luminance(tokenHex(dark, "--surface-3"));
    const s4 = luminance(tokenHex(dark, "--surface-4"));
    expect(s0).toBeLessThan(s1); // chrome darker than content
    expect(s1).toBeLessThan(s2); // content darker than cards
    expect(s2).toBeLessThan(s3);
    expect(s3).toBeLessThan(s4);
  });

  it("warm-light: chrome (s0) < content canvas (s1) < cards (s2)", () => {
    // :root is the warm-light theme.
    const light = selectorBlock(":root");
    const s0 = luminance(tokenHex(light, "--surface-0"));
    const s1 = luminance(tokenHex(light, "--surface-1"));
    const s2 = luminance(tokenHex(light, "--surface-2"));
    expect(s0).toBeLessThan(s1); // chrome tint darker than canvas
    expect(s1).toBeLessThan(s2); // canvas darker than raised paper cards
  });

  it("dark: sidebar/nav (chrome) is the DARKEST surface — was inverted before", () => {
    const dark = selectorBlock(".dark");
    // --sidebar aliases --surface-0; --background aliases --surface-1.
    expect(dark).toContain("--sidebar: var(--surface-0)");
    expect(dark).toContain("--background: var(--surface-1)");
    // cards float above the canvas.
    expect(dark).toContain("--card: var(--surface-2)");
  });

  it("light: sidebar (chrome) tinted below the content canvas", () => {
    const light = selectorBlock(":root");
    expect(light).toContain("--sidebar: var(--surface-0)");
    expect(light).toContain("--background: var(--surface-1)");
    expect(light).toContain("--card: var(--surface-2)");
  });
});
