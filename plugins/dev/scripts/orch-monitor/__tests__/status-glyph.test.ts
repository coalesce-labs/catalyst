// status-glyph.test.ts — CTL-900 / HOME2 acceptance guards for the StatusIcon
// glyph + PhaseStrip wiring into the calm Inbox row + reading pane.
//
// The PURE phase model (fraction math / done detection / index / color) is unit-
// tested in phase-model.test.ts, and its drift to the canonical pipeline is locked
// in board-phase-drift.test.ts. `bun test` has no DOM, so — the same way
// home-surface.test.ts guards HOME1 — the STRUCTURAL Gherkin (a single glyph on the
// row with NO text status badge; the disc+check done terminal; the reading-pane
// "where it's at" phase strip) is asserted by static source analysis: read the
// component .tsx as text and assert the load-bearing wiring.
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const UI_SRC = join(HERE, "..", "ui", "src");
const read = (rel: string) => readFileSync(join(UI_SRC, rel), "utf8");

function stripComments(src: string): string {
  return src
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const statusIconSrc = read("components/home/status-icon.tsx");
const phaseStripSrc = read("components/home/phase-strip.tsx");
const inboxRowSrc = read("components/home/inbox-row.tsx");
const readingPaneSrc = read("components/home/reading-pane.tsx");

const iconCode = stripComments(statusIconSrc);
const stripCode = stripComments(phaseStripSrc);
const rowCode = stripComments(inboxRowSrc);
const paneCode = stripComments(readingPaneSrc);

// ── Scenario: A row shows progress and stage in one glyph ─────────────────────
describe("Scenario: A row shows progress and stage in one glyph (CTL-900)", () => {
  it("the inbox row renders a single StatusIcon glyph fed by the ticket's phase + status", () => {
    expect(rowCode).toContain("StatusIcon");
    // Fed from the read-model item's phase + status (board-data deriveActiveState).
    expect(rowCode).toMatch(/phase=\{row\.ticket\.phase\}/);
    expect(rowCode).toMatch(/status=\{row\.ticket\.status\}/);
  });

  it("the glyph's fill is proportional to (phaseIndex+1)/total via the phase model", () => {
    // The icon derives the index from the canonical model and the fraction off it.
    expect(iconCode).toContain("phaseIndexOf");
    expect(iconCode).toContain("phaseFraction");
    expect(iconCode).toContain("PHASE_COUNT");
  });

  it("the glyph is colored by the current phase (early->late spectrum), via phaseColor", () => {
    expect(iconCode).toContain("phaseColor");
  });

  it("the glyph NEVER hard-codes the reserved live cyan (#5be0ff)", () => {
    // Check the comment-STRIPPED code: the doc comments legitimately mention the
    // reserved cyan to explain it is deliberately NOT used, so only real code is
    // guarded (mirrors home-surface.test.ts's stripped no-Linear guard).
    expect(iconCode.toLowerCase()).not.toContain("5be0ff");
    expect(stripCode.toLowerCase()).not.toContain("5be0ff");
  });

  it("NO separate text status badge is shown on the row (the glyph IS the status)", () => {
    // The row must not render a status/label Badge chip — status reads from the
    // glyph alone (Direction A). The only row affordances are the section accent,
    // the key, the title, the muted sub-label, and the single needs-you verb.
    expect(rowCode).not.toContain("components/ui/badge");
    expect(rowCode).not.toMatch(/<Badge\b/);
  });
});

// ── Scenario: A finished item reads as done ───────────────────────────────────
describe("Scenario: A finished item reads as done (CTL-900)", () => {
  it("the glyph flips to a filled disc + check on the done terminal status", () => {
    expect(iconCode).toContain("isDoneStatus");
    // The terminal branch draws a filled disc + a check path.
    expect(iconCode).toContain("checkPath");
    expect(iconCode).toMatch(/done\s*\?/);
  });
});

// ── Scenario: The reading pane shows the full phase strip ─────────────────────
describe("Scenario: The reading pane shows the full phase strip (CTL-900)", () => {
  it("the reading pane renders a 'where it's at' block with the PhaseStrip", () => {
    expect(paneCode).toContain("PhaseStrip");
    expect(readingPaneSrc.toLowerCase()).toContain("where it's at");
    // Driven by the selected row's ticket phase/status.
    expect(paneCode).toMatch(/phase=\{row\.ticket\.phase\}/);
  });

  it("the reading-pane header also carries the single StatusIcon glyph", () => {
    expect(paneCode).toContain("StatusIcon");
  });

  it("the PhaseStrip splits steps into done / current / pending off the phase index", () => {
    expect(stripCode).toContain("isDone");
    expect(stripCode).toContain("isCurrent");
    // Current = larger ringed dot (boxShadow ring + larger size); pending = faint
    // hollow dot (transparent bg + a border); done = solid phase-color dot.
    expect(stripCode).toContain("boxShadow");
    expect(stripCode).toMatch(/size-2\.5/); // larger current dot
    expect(stripCode).toMatch(/size-1\.5/); // smaller done/pending dot
  });

  it("the PhaseStrip walks the canonical PHASE_LIST (no synthetic 'done' step)", () => {
    expect(stripCode).toContain("PHASE_LIST");
    // It must not re-introduce a synthetic terminal 'done' pseudo-phase.
    expect(stripCode).not.toMatch(/"done"/);
  });
});

// ── No-regression: the glyph components stay pure (no Linear / fetch) ──────────
describe("no-regression: the glyph tree never reaches for Linear or a fetch (CTL-900)", () => {
  it("status-icon / phase-strip open no network and touch no Linear", () => {
    for (const src of [iconCode, stripCode]) {
      expect(src.toLowerCase()).not.toContain("linearis");
      expect(src).not.toMatch(/\bnew EventSource\b/);
      expect(src).not.toMatch(/\bfetch\(/);
    }
  });
});
