// swimlane-structure.test.ts — CTL-1151 source-contract suite.
// Asserts the continuous-lane-backdrop structure:
//   • A LaneBackdrop component paints ONE full-height column lane per column
//     behind all bands/cards (replacing the per-cell tray paint).
//   • LaneCardsRow cells are transparent flow containers (no tray paint).
//   • The per-project hue rides the GroupLabelRow band overlay, not the lane.
//
//   cd ui && bun test src/board/swimlane-structure.test.ts
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(__dirname, "Swimlane.tsx"), "utf8");

// helper: isolate the function body by brace-matching from the signature
function fnBody(name: string): string {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found`);
  const open = src.indexOf("{", src.indexOf(")", start));
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(open, i + 1);
  }
  throw new Error(`unbalanced ${name}`);
}

describe("CTL-1151 — continuous lane backdrop exists", () => {
  it("renders a LaneBackdrop layer", () => {
    expect(src).toMatch(/function LaneBackdrop\(/);
    expect(src).toMatch(/data-lane-backdrop="true"/);
  });
  it("the backdrop layer is absolutely positioned and full-height", () => {
    const body = fnBody("LaneBackdrop");
    expect(body).toMatch(/position:\s*"absolute"/);
    // inset:0 (or top/right/bottom/left) so it stretches to bumpRef's full height
    expect(body).toMatch(/inset:\s*0|height:\s*"100%"/);
    // one strip per column at the recessed lane surface
    expect(body).toContain("C.s0");
  });
});

describe("CTL-1151 — LaneCardsRow cells no longer paint a column tray", () => {
  const body = fnBody("LaneCardsRow");
  it("cell style carries no background (lane paint moved to backdrop)", () => {
    // the cell <div> must not set `background: laneBg ?? C.s0`
    expect(body).not.toMatch(/background:\s*laneBg\s*\?\?\s*C\.s0/);
  });
  it("cell style carries no per-cell borderRadius:10 / TRAY_LIFT (the chop)", () => {
    expect(body).not.toMatch(/borderRadius:\s*10\b/);
    expect(body).not.toContain("TRAY_LIFT");
  });
  it("preserves the water-fill measurement attributes", () => {
    expect(body).toContain('data-lane-cell="true"');
    expect(src).toMatch(/data-lane-key=\{laneKey\}/);
  });
});

describe("CTL-1151 — hue on the band overlay, not the continuous lane", () => {
  it("the lane backdrop strip is neutral C.s0 (no laneBg tint)", () => {
    const body = fnBody("LaneBackdrop");
    expect(body).not.toContain("laneBg");
    expect(body).not.toContain("laneSurfaceBg");
  });
  it("GroupLabelRow still carries the per-project tint (laneBg)", () => {
    const body = fnBody("GroupLabelRow");
    expect(body).toMatch(/laneBg\s*\?\?\s*C\.s1/);
  });
  it("SwimlaneBoard passes laneBg to GroupLabelRow but NOT to LaneCardsRow", () => {
    // LaneCardsRow no longer receives a laneBg prop (the lane paint is gone)
    const board = src.slice(src.indexOf("function SwimlaneBoard"));
    expect(board).toMatch(/<GroupLabelRow[\s\S]*?laneBg=\{laneBg\}/);
    expect(board).not.toMatch(/<LaneCardsRow[\s\S]*?laneBg=\{laneBg\}/);
  });
});
