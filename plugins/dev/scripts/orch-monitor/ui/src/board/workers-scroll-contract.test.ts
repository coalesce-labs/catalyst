// workers-scroll-contract.test.ts — CTL-1082 acceptance guard for the Workers-surface
// scroll architecture.
//
// The bug: CTL-1016 Phase 3 (PR #1888) extracted ControlTower out of the deleted
// QueueSurface and dropped the overflow-y wrapper that QueueSurface supplied.
// Board.tsx then rendered ControlTower and WorkerSwimlaneBoard as two sibling
// flex children inside a fixed-height flex column. The zero-basis swimlane scroller
// (flex:1 1 0) was assigned 100% of the flex shrink and collapsed to 0px whenever
// ControlTower's natural height crowded the column.
//
// The fix wraps both Workers children in a single overflow-y:auto flex child
// (flex:1; minHeight:0) carrying the "workers-scroll" scroll-restoration id,
// and passes fill={false} embedded={false} to WorkerSwimlaneBoard so the inner
// board sizes to content while the wrapper owns vertical scrolling.
//
// `bun test` has no DOM, so — following detail-scroll-contract.test.ts and
// detail-nav.test.ts — this guards the load-bearing structure via static source
// analysis. Live scroll behaviour (a real viewport revealing the kanban at short
// height) was verified manually; the static guards below lock the CSS architecture
// that makes that behaviour possible.
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const boardSrc = readFileSync(join(__dirname, "Board.tsx"), "utf8");

/** Brace-balanced body of the inline style object that follows `attr`. */
function styleAfterAttr(src: string, attr: string): string {
  const at = src.indexOf(attr);
  if (at < 0) throw new Error(`attribute ${attr} not found`);
  const styleAt = src.indexOf("style={{", at);
  if (styleAt < 0) throw new Error(`no inline style after ${attr}`);
  let depth = 0;
  let i = styleAt + "style={".length;
  const start = i;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  return src.slice(start, i);
}

describe("CTL-1082 — Workers surface scroll contract", () => {
  it("wraps the Workers view in a single vertical scroll container", () => {
    const style = styleAfterAttr(boardSrc, 'data-scroll-restoration-id="workers-scroll"');
    expect(style).toContain("overflowY");
    expect(style).toContain('"auto"');
    expect(style).toContain("flex: 1");
    expect(style).toContain("minHeight: 0");
  });

  it("uses the overlay-scroll class on the Workers wrapper", () => {
    const idx = boardSrc.indexOf('data-scroll-restoration-id="workers-scroll"');
    const tagStart = boardSrc.lastIndexOf("<div", idx);
    expect(boardSrc.slice(tagStart, idx)).toContain("cat-overlay-scroll");
  });

  it("renders WorkerSwimlaneBoard as a content-sized child (no inner vertical fill)", () => {
    const at = boardSrc.indexOf("<WorkerSwimlaneBoard");
    expect(at).toBeGreaterThan(-1);
    const tag = boardSrc.slice(at, boardSrc.indexOf("/>", at));
    expect(tag).toContain("fill={false}");
    expect(tag).toContain("embedded={false}");
  });

  it("keeps a single Workers-view body block (ControlTower + board co-located)", () => {
    // Guard against the original split: two separate `data && view === "workers" &&`
    // blocks (one for ControlTower, one for WorkerSwimlaneBoard). The toolbar header
    // also uses `view === "workers" &&` (without `data &&`) — we only count body blocks.
    const blocks = boardSrc.match(/data && view === "workers" &&/g) ?? [];
    expect(blocks.length).toBe(1);
  });
});
