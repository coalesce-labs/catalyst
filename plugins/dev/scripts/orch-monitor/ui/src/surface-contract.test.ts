// surface-contract.test.ts — CTL-1033 the SURFACE token contract.
//
// Five guards that make the elevation system self-enforcing so a future change
// cannot silently re-introduce the bugs this ticket fixed:
//   1. board-tokens ↔ CSS sync — C.s* equal the resolved .dark semantic hexes.
//   2. No local ramps — no `const C = {` and no stale ramp hexes outside
//      board-tokens.ts (kills the three-ramp drift that made pages render darker
//      than the sidebar).
//   3. Route shells consume tokens — every route content shell is canvas, never a
//      hardcoded background (the "four divergent backgrounds" bug).
//   4. Single PHASE source — formatters/board-display columns resolve the ONE
//      board-tokens PHASE map; no Tailwind-default #3b82f6 in the phase maps.
//
//   cd ui && bun test src/surface-contract.test.ts
import { describe, it, expect } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { C } from "./board/board-tokens";
import { PHASE } from "./board/board-tokens";
import { PHASE_COLORS } from "./lib/formatters";
import { PHASE_COLUMNS, LINEAR_COLUMNS } from "./board/board-display";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = __dirname;
const css = readFileSync(join(SRC, "app.css"), "utf8");

function selectorBlock(selector: string): string {
  const re = new RegExp(`${selector.replace(".", "\\.")}\\s*\\{`);
  const m = re.exec(css);
  if (!m) throw new Error(`selector ${selector} not found`);
  const open = css.indexOf("{", m.index);
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

function tokenHex(block: string, name: string): string {
  const re = new RegExp(`${name}\\s*:\\s*(#[0-9a-fA-F]{6})\\s*;`);
  const m = block.match(re);
  if (!m) throw new Error(`token ${name} (literal hex) not found in block`);
  return m[1].toLowerCase();
}

/** Walk ui/src for *.ts / *.tsx, excluding tests and board-tokens.ts. */
function sourceFiles(): string[] {
  const out: string[] = [];
  function walk(dir: string) {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      const s = statSync(p);
      if (s.isDirectory()) {
        walk(p);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(entry)) continue;
      if (/\.test\.(ts|tsx)$/.test(entry)) continue;
      if (entry === "board-tokens.ts") continue;
      out.push(p);
    }
  }
  walk(SRC);
  return out;
}

describe("CTL-1033 surface contract — board-tokens ↔ CSS sync (kills three-ramp drift)", () => {
  it("C.s0/s1/subtle/s2/s3/s4 equal the resolved .dark semantic hexes", () => {
    const dark = selectorBlock(".dark");
    expect(C.s0.toLowerCase()).toBe(tokenHex(dark, "--surface-chrome"));
    expect(C.s1.toLowerCase()).toBe(tokenHex(dark, "--surface-canvas"));
    expect(C.subtle.toLowerCase()).toBe(tokenHex(dark, "--surface-subtle"));
    expect(C.s2.toLowerCase()).toBe(tokenHex(dark, "--surface-card"));
    expect(C.s3.toLowerCase()).toBe(tokenHex(dark, "--surface-elevated"));
    expect(C.s4.toLowerCase()).toBe(tokenHex(dark, "--surface-hover"));
  });
});

describe("CTL-1033 surface contract — no local ramps (one token system)", () => {
  const files = sourceFiles();
  // The stale local-ramp SURFACE hexes — the values the 12 deleted ramps painted
  // backgrounds/borders with. These must NOT survive anywhere outside board-tokens.ts
  // (their presence is the three-ramp drift that made pages render darker than the
  // sidebar). Accent / text / data-viz hexes are §6-out-of-scope and excluded here.
  const STALE_SURFACE_HEXES = [
    "#0b0d10",
    "#111318",
    "#161a21",
    "#1c222b",
    "#262d36",
  ];

  /** Strip line + block comments so a hex MENTIONED in documentation (e.g. "the
   *  reserved #5be0ff cyan") never trips the literal scan. */
  function stripComments(text: string): string {
    return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  }

  it("no `const C = {` ramp exists outside board-tokens.ts", () => {
    const offenders = files.filter((f) =>
      /\bconst C = \{/.test(stripComments(readFileSync(f, "utf8"))),
    );
    expect(offenders.map((f) => relative(SRC, f))).toEqual([]);
  });

  it("no stale ramp SURFACE hex literals survive outside board-tokens.ts", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const text = stripComments(readFileSync(f, "utf8")).toLowerCase();
      for (const hex of STALE_SURFACE_HEXES) {
        if (text.includes(hex)) {
          offenders.push(`${relative(SRC, f)} → ${hex}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("CTL-1033 surface contract — every route shell consumes the shared tokens", () => {
  const SHELLS = [
    "board/Board.tsx",
    "board/Shell.tsx",
    "components/queue/queue-surface.tsx",
    "components/home/home-surface.tsx",
    "components/settings-surface.tsx",
    "components/observe/finops-surface.tsx",
    "components/observe/telemetry-surface.tsx",
    "components/observe/utilization-surface.tsx",
    "components/observe/fleetops-surface.tsx",
  ];

  for (const shell of SHELLS) {
    it(`${shell} paints its shell from a shared surface token (canvas), not a literal`, () => {
      const text = readFileSync(join(SRC, shell), "utf8");
      // The shell must reference a canvas token (utility class or C.s1).
      expect(text).toMatch(/bg-surface-(1|canvas)|C\.s1/);
      // …and must NOT hardcode a shell background hex.
      expect(text).not.toMatch(/background:\s*"#/);
      expect(text).not.toMatch(/bg-\[#/);
    });
  }
});

describe("CTL-1033 surface contract — single PHASE source", () => {
  it("PHASE_COLORS resolves the canonical PHASE map", () => {
    expect(PHASE_COLORS.research).toBe(PHASE.research);
    expect(PHASE_COLORS.plan).toBe(PHASE.plan);
    expect(PHASE_COLORS.implement).toBe(PHASE.implement);
    // legacy verb alias still resolves the canonical color
    expect(PHASE_COLORS.researching).toBe(PHASE.research);
    expect(PHASE_COLORS.implementing).toBe(PHASE.implement);
  });

  it("every PHASE_COLUMNS / STATUS_COLUMNS accent === PHASE[key]", () => {
    const STATUS_TO_PHASE: Record<string, string> = {
      Todo: "todo",
      Triage: "triage",
      Research: "research",
      Plan: "plan",
      Implement: "implement",
      Validate: "verify",
      PR: "pr",
      Done: "done",
    };
    for (const col of PHASE_COLUMNS) {
      expect(col.c).toBe(PHASE[col.key]);
    }
    for (const col of LINEAR_COLUMNS) {
      expect(col.c).toBe(PHASE[STATUS_TO_PHASE[col.key]]);
    }
  });

  it("no Tailwind-default #3b82f6 in the phase maps (formatters + board-display)", () => {
    const formatters = readFileSync(join(SRC, "lib/formatters.ts"), "utf8");
    const boardDisplay = readFileSync(join(SRC, "board/board-display.ts"), "utf8");
    expect(formatters).not.toContain("#3b82f6");
    expect(boardDisplay).not.toContain("#3b82f6");
  });
});
