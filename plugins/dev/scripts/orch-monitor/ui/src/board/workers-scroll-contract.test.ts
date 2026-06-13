// workers-scroll-contract.test.ts — CTL-1098 acceptance guard for the Workers-surface
// screen-split architecture.
//
// CTL-1082 established a single shared scroll wrapper around ControlTower +
// WorkerSwimlaneBoard to fix the zero-height swimlane collapse. CTL-1083 added
// ControlTower's 45vh height cap. CTL-1098 supersedes both: the two panels are
// now separate screens rendered one-at-a-time, switched by a header Seg. This
// eliminates the sticky ColumnHeaderRow overlap structurally — the panels are
// never co-mounted, so the swimlane header can never escape into the dispatch
// scroller.
//
// `bun test` has no DOM, so — following detail-scroll-contract.test.ts and
// detail-nav.test.ts — this guards the load-bearing structure via static source
// analysis. Live scroll behaviour (a real viewport) was verified manually; the
// static guards below lock the CSS architecture that makes that behaviour possible.
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

describe("CTL-1098 — Workers surface is two one-at-a-time screens", () => {
  it("declares a workerSurface sub-mode defaulting to dispatch", () => {
    // local sub-mode state, not co-rendered panels
    expect(boardSrc).toMatch(/workerSurface/);
    expect(boardSrc).toMatch(/setWorkerSurface/);
    expect(boardSrc).toMatch(/useState<\s*"dispatch"\s*\|\s*"board"\s*>\(\s*"dispatch"\s*\)/);
  });

  it("renders the Dispatch and Board screens mutually exclusively", () => {
    // exactly one ControlTower mount, guarded by the dispatch sub-mode
    expect(boardSrc).toMatch(/workerSurface === "dispatch"/);
    expect(boardSrc).toMatch(/workerSurface === "board"/);
  });

  it("gives the Board screen a self-contained scroll via fill+embedded", () => {
    const at = boardSrc.indexOf("<WorkerSwimlaneBoard");
    expect(at).toBeGreaterThan(-1);
    const tag = boardSrc.slice(at, boardSrc.indexOf("/>", at));
    expect(tag).toContain("fill={true}");
    expect(tag).toContain("embedded={true}");
  });

  it("keeps the Dispatch screen in its own scroll container", () => {
    // distinct restoration id so the two screens don't share a scroll anchor
    expect(boardSrc).toContain('data-scroll-restoration-id="dispatch-scroll"');
    const idx = boardSrc.indexOf('data-scroll-restoration-id="dispatch-scroll"');
    const tagStart = boardSrc.lastIndexOf("<div", idx);
    expect(boardSrc.slice(tagStart, idx)).toContain("cat-overlay-scroll");
    const style = styleAfterAttr(boardSrc, 'data-scroll-restoration-id="dispatch-scroll"');
    expect(style).toContain("overflowY");
    expect(style).toContain('"auto"');
    expect(style).toContain("flex: 1");
    expect(style).toContain("minHeight: 0");
  });

  it("wires the surface switch to local state", () => {
    expect(boardSrc).toContain("onChange={setWorkerSurface}");
  });
});
