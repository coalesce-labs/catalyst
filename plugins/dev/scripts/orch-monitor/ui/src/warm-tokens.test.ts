// warm-tokens.test.ts — CTL-1071 token CONTRACT tests.
// Phases 1 (Pass A), 2 (Pass C), and 4 (Pass B) from the spike plan.
// Mirrors the selectorBlock/tokenHex helpers from elevation-ladder.test.ts.
//
//   cd plugins/dev/scripts/orch-monitor && bun test src/warm-tokens.test.ts
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { LIVE } from "./board/board-tokens";
import { SEMANTIC_PILL_CLASSES } from "./lib/formatters";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = __dirname;
const css = readFileSync(join(SRC, "app.css"), "utf8");

function tokenHex(block: string, name: string): string {
  const re = new RegExp(`${name}\\s*:\\s*(#[0-9a-fA-F]{6})\\s*;`);
  const m = block.match(re);
  if (!m) throw new Error(`token ${name} (literal hex) not found in block`);
  return m[1];
}

function selectorBlock(selector: string): string {
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

/** Balanced body of the CTL-1099 `.dark[data-theme="slate"]` slate-dark rule.
 *  (The generic selectorBlock can't escape the `[...]` attribute selector, so
 *  match the literal rule head directly.) */
function slateDarkBlock(): string {
  // Match the literal rule HEAD (selector immediately followed by optional
  // whitespace + `{`), not a mention inside a comment.
  const m = /\.dark\[data-theme="slate"\]\s*\{/.exec(css);
  if (!m) throw new Error("slate-dark rule not found");
  const open = css.indexOf("{", m.index);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") {
      depth--;
      if (depth === 0) return css.slice(open, i + 1);
    }
  }
  throw new Error("unbalanced slate-dark block");
}

// ── Phase 1 (Pass A): warm-light accent fork ──────────────────────────────

describe("CTL-1071 Pass A — warm-light accent fork", () => {
  it("--color-light-accent is terracotta, not Linear-blue", () => {
    const root = selectorBlock(":root");
    expect(tokenHex(root, "--color-light-accent")).toBe("#a9512f");
    expect(root).not.toContain("#1f6feb");
  });
  it("warm-dark accent is terracotta; slate-dark preserves blue (CTL-1099)", () => {
    // CTL-1099: the base `.dark` accent is now TERRACOTTA, and the @theme inline
    // `--color-accent` became `var(--accent)` (so it flips with the brand axis).
    // The OLD blue identity moved verbatim to `.dark[data-theme="slate"]`.
    expect(selectorBlock(".dark").trim()).toContain("--accent: #d28e63");
    expect(slateDarkBlock()).toContain("--accent: #5e9ee8");
    // The @theme inline accent is the per-brand var, not a literal blue.
    expect(css).toContain("--color-accent: var(--accent)");
  });
});

// ── Phase 1 (Pass A): chart palette LIVE-collision fix ───────────────────

describe("CTL-1071 Pass A — chart palette retires the LIVE collision", () => {
  const CHARTS = [
    "--chart-1",
    "--chart-2",
    "--chart-3",
    "--chart-4",
    "--chart-5",
    "--chart-6",
  ] as const;
  for (const block of [":root", ".dark"] as const) {
    it(`${block}: no chart slot equals the reserved LIVE signal (${LIVE})`, () => {
      const b = selectorBlock(block);
      for (const c of CHARTS)
        expect(tokenHex(b, c).toLowerCase()).not.toBe(LIVE.toLowerCase());
    });
    it(`${block}: all six chart slots are mutually distinct`, () => {
      const b = selectorBlock(block);
      const hexes = CHARTS.map((c) => tokenHex(b, c).toLowerCase());
      expect(new Set(hexes).size).toBe(hexes.length);
    });
  }
});

// ── Phase 2 (Pass C): serif typography token ─────────────────────────────

describe("CTL-1071 Pass C — serif typography token", () => {
  it("--font-serif is defined with a zero-FOUT system stack", () => {
    expect(css).toMatch(/--font-serif:\s*[^;]*Georgia[^;]*;/);
    expect(css).toMatch(/--font-serif:\s*[^;]*serif\s*;/);
  });
  it("the ticket reading surface applies the serif token", () => {
    const block = css.slice(css.indexOf(".ticket-desc h1"));
    expect(block.slice(0, 400)).toContain("var(--font-serif)");
  });
});

// ── Phase 4 (Pass B): semantic pills are token-derived ───────────────────

describe("CTL-1071 Pass B — semantic pills are token-derived", () => {
  it("no SEMANTIC_PILL_CLASSES value hardcodes an arbitrary hex", () => {
    for (const v of Object.values(SEMANTIC_PILL_CLASSES)) {
      expect(v).not.toMatch(/\[#[0-9a-fA-F]{6}\]/);
    }
  });
});
