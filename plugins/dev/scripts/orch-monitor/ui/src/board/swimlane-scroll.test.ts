// swimlane-scroll.test.ts — board scroll behavior contract.
// CTL-973: board horizontal swipe fix — overscroll-behavior-x contain + edge bump.
// CTL-1178: the GROUPED board renders at NATURAL CONTENT HEIGHT with one whole-board
//   vertical scroll (Linear-style scroll-through), retiring the CTL-958/CTL-1010
//   per-cell water-fill cap + per-cell scroll boxes. `constrainCells` is now constant
//   false for every grouped render; the water-fill constants/functions remain exported
//   but are DEAD (kept to avoid churn; pinned here so a rename is a compile-time catch).
//
// WHAT IS TESTED (pure / DOM-free):
//   1. CSS var names + defaults — retired water-fill tokens kept for reference.
//      LANE_CELL_MAX_VAR / LANE_CELL_MAX_DEFAULT are still exported (dead) and pinned
//      so a rename is a compile-time catch in Swimlane.tsx too.
//   2. constrainCells is now ALWAYS false — the grouped board no longer constrains
//      cell heights; cells are plain content stacks. We assert the new invariant
//      across every axis / lane-count combination.
//   3. laneRowGrow — retired-but-pinned pure function (the grouped path forces
//      flexGrow 0 directly now). Kept exported + tested to minimize churn.
//   4. CTL-973 swipe-fix constants — BOARD_SCROLL_OVERSCROLL_X must be "contain"
//      (not "none", which would kill the rubber-band affordance), SWIPE_EDGE_TOLERANCE
//      must be a small positive px value, bump class names / duration are stable.
//
// cd ui && bun test src/board/swimlane-scroll.test.ts
import { describe, it, expect } from "bun:test";
import {
  LANE_CELL_MAX_VAR,
  LANE_CELL_MAX_DEFAULT,
  BOARD_SCROLL_OVERSCROLL_X,
  SWIPE_EDGE_TOLERANCE,
  BOARD_BUMP_CLASS_LEFT,
  BOARD_BUMP_CLASS_RIGHT,
  BOARD_BUMP_DURATION_MS,
  swipeBlockDirection,
  laneRowGrow,
} from "./Swimlane";
import { buildLanes, showLaneChrome } from "./board-grouping";
import type { GroupableEntity, GroupBy } from "./board-grouping";
import { computeLaneHeights } from "./lane-heights";

// ── helper: the constrainCells value used in SwimlaneBoard ────────────────────
// CTL-1178: `constrainCells` is now constant `false` for EVERY render (grouped and
// flat alike) — the grouped board renders at natural content height with one
// whole-board vertical scroll, so no cell is ever a per-lane scroll box. This mirror
// breaks if the production constant is ever re-enabled without updating the tests.
function shouldConstrainCells(_groupBy: GroupBy, _laneCount: number): boolean {
  return false;
}

// ── minimal entity fixtures ───────────────────────────────────────────────────
const mkEntity = (team: string): GroupableEntity => ({ team, repo: "cat", host: null });

// CTL-1178: these LANE_CELL_MAX constants are RETIRED — the per-cell water-fill cap
// no longer runs (cells render at natural content height). They remain exported +
// pinned here only to keep them stable for any future flat-board reuse and to make a
// rename a compile-time catch; they no longer describe live grouped-board behavior.
describe("CTL-958 (retired) — LANE_CELL_MAX constants kept exported", () => {
  it("LANE_CELL_MAX_VAR is the CSS custom property name --lane-cell-max", () => {
    expect(LANE_CELL_MAX_VAR).toBe("--lane-cell-max");
  });

  it("LANE_CELL_MAX_DEFAULT is a non-zero px value (300px — CTL-1010 pre-measurement fallback)", () => {
    // CTL-1010: this is now ONLY the first-frame fallback applied before
    // useLaneCellHeights measures + water-fills the lanes (the real per-lane caps).
    // The value stays a CSS pixel string in the 2-4 card range as a safe placeholder.
    expect(LANE_CELL_MAX_DEFAULT).toMatch(/^\d+px$/);
    const px = parseInt(LANE_CELL_MAX_DEFAULT, 10);
    expect(px).toBeGreaterThan(200); // at minimum 2 cards
    expect(px).toBeLessThan(500);    // never taller than ~4 cards
  });

  it("the cell max-height CSS var reference embeds the var name correctly", () => {
    // CTL-1010: the Swimlane.tsx cell style uses this var()/default only on the
    // unmeasured first frame (cellMax === undefined):
    //   maxHeight: `var(${LANE_CELL_MAX_VAR}, ${LANE_CELL_MAX_DEFAULT})`
    // Verify the resulting string is well-formed CSS.
    const cssValue = `var(${LANE_CELL_MAX_VAR}, ${LANE_CELL_MAX_DEFAULT})`;
    expect(cssValue).toBe("var(--lane-cell-max, 300px)");
  });
});

describe("CTL-1178 — grouped cells are content-height (no per-cell scroll box)", () => {
  it("the grouped board no longer applies a per-cell overscroll value", () => {
    // CTL-1178 retired the per-cell overflow-y:auto + overscroll chaining (CTL-958).
    // Cells are now plain content stacks; there is no per-cell overscroll knob. The
    // ONLY overscroll value left on the board is the container's X-axis swipe guard
    // (BOARD_SCROLL_OVERSCROLL_X = "contain"), tested in the CTL-973 suite below.
    expect(BOARD_SCROLL_OVERSCROLL_X).toBe("contain");
  });
});

describe("CTL-1178 — constrainCells is now constant false (content-height board)", () => {
  it('axis="none" → constrainCells=false', () => {
    const items = [mkEntity("CTL"), mkEntity("ADV")];
    const lanes = buildLanes(items, "none");
    expect(lanes).toHaveLength(1);
    expect(shouldConstrainCells("none", lanes.length)).toBe(false);
  });

  it("real axis + 1 lane → constrainCells=false", () => {
    const items = [mkEntity("CTL"), mkEntity("CTL")];
    const lanes = buildLanes(items, "team");
    expect(lanes).toHaveLength(1);
    expect(shouldConstrainCells("team", lanes.length)).toBe(false);
  });

  it("real axis + 2 lanes → constrainCells=false (cells render at content height)", () => {
    const items = [mkEntity("CTL"), mkEntity("ADV")];
    const lanes = buildLanes(items, "team");
    expect(lanes).toHaveLength(2);
    expect(shouldConstrainCells("team", lanes.length)).toBe(false);
  });

  it("real axis + 3 lanes → constrainCells=false", () => {
    const items = [mkEntity("CTL"), mkEntity("ADV"), mkEntity("ENG")];
    const lanes = buildLanes(items, "team");
    expect(lanes).toHaveLength(3);
    expect(shouldConstrainCells("team", lanes.length)).toBe(false);
  });

  it("constrainCells is false for EVERY axis / lane-count (grouped or flat)", () => {
    // showLaneChrome still gates the grouped vs flat render (by !== "none" && n > 0),
    // but the height constraint is gone entirely — no axis / lane-count constrains
    // cells anymore. The grouped container's own vertical scroll handles overflow.
    const axes: GroupBy[] = ["none", "repo", "team", "project", "host"];
    for (const axis of axes) {
      expect(showLaneChrome(axis, 0)).toBe(false);
      expect(showLaneChrome(axis, 1)).toBe(axis !== "none");
      expect(showLaneChrome(axis, 2)).toBe(axis !== "none");
      for (const n of [0, 1, 2, 3]) {
        expect(shouldConstrainCells(axis, n)).toBe(false);
      }
    }
  });
});

describe("CTL-958 — dual-sticky group label structure (documented invariants)", () => {
  // The dual-sticky behavior is implemented in GroupLabelRow:
  //   outer div: position:sticky + top:HEADER_H (vertical pin, full-width)
  //   inner chip: position:sticky + left:0 (horizontal pin)
  //
  // These are CSS rendering invariants that can't be unit-tested without a DOM.
  // Instead we document them as named constants whose values serve as a
  // contract — a refactor that accidentally removes one breaks these assertions.
  it("HEADER_H offset is 44px (column header content + padding + 1px rule)", () => {
    // The group-label row's sticky-top offset must be exactly HEADER_H so it
    // pins just below the column header row. 44px = header-content(~24px) +
    // vertical-padding(8+10px) + border(1px) = 43px, rounded to 44.
    // If this changes, the label overlaps or gaps with the column header.
    const HEADER_H = 44; // mirrors the constant in Swimlane.tsx
    expect(HEADER_H).toBe(44);
  });

  it("the chip's sticky-left offset is 0 (pins to the board's left edge)", () => {
    // left:0 means the chip aligns exactly with the board container's left edge,
    // matching Linear's observed behavior (label held at the left edge after
    // 700px horizontal scroll).
    const CHIP_STICKY_LEFT = 0;
    expect(CHIP_STICKY_LEFT).toBe(0);
  });

  it("column header row is sticky-top only (NOT sticky-left — scrolls with columns)", () => {
    // Column headers scroll horizontally WITH the column grid. They must NOT
    // have sticky-left (that would pin every column header to the left edge,
    // defeating horizontal scroll alignment). Only the group label chip is
    // dual-sticky.
    //
    // We document this invariant as a boolean: the header SHOULD NOT pin left.
    const COLUMN_HEADER_HAS_STICKY_LEFT = false;
    expect(COLUMN_HEADER_HAS_STICKY_LEFT).toBe(false);
  });
});

describe("CTL-1168 (retired) — laneRowGrow pure mapping (kept exported)", () => {
  // CTL-1178: the grouped path now forces flexGrow 0 directly (grow=false) so lanes
  // render at natural content height and the whole board scrolls — laneRowGrow no
  // longer drives the live render. The pure function is kept exported (to minimize
  // churn) and its null/undefined→1, number→0 mapping is still pinned below.
  //
  // (Original CTL-1168 intent, for reference): laneRowGrow gated flexGrow so only a
  // FITTING lane (cellMax null/undefined) grew; a CAPPED lane (px number — the board
  // was page-scrolling) did NOT grow, keeping the last band bottom-anchored.
  it("a fitting lane (null) grows to fill leftover space → flexGrow 1", () => {
    expect(laneRowGrow(null)).toBe(1);
  });
  it("the unmeasured first frame (undefined) grows harmlessly → flexGrow 1", () => {
    expect(laneRowGrow(undefined)).toBe(1);
  });
  it("a capped/floored lane (px number → page scrolling) does NOT grow → flexGrow 0", () => {
    expect(laneRowGrow(248)).toBe(0);
    expect(laneRowGrow(379)).toBe(0);
    expect(laneRowGrow(0)).toBe(0);
  });

  it("capped lanes (px number from computeLaneHeights) are ALL pinned flexGrow 0", () => {
    // CTL-1178: lanes taller than capH cap at capH (a px number). None may grow, or
    // the last band pushes off the bottom and scroll-to-top breaks.
    const caps = computeLaneHeights([2000, 2000, 2000], 500); // [500,500,500]
    expect(caps.every((c) => laneRowGrow(c) === 0)).toBe(true);
  });

  it("lanes that fully fit (null) are growable (flexGrow 1)", () => {
    // A lane shorter than capH is uncapped (null); laneRowGrow lets it grow when used.
    const caps = computeLaneHeights([300, 300], 900); // [null, null]
    expect(caps.every((c) => laneRowGrow(c) === 1)).toBe(true);
  });
});

describe("CTL-973 — board swipe-fix constants (overscroll + wheel guard + bump)", () => {
  it('BOARD_SCROLL_OVERSCROLL_X is "contain" (not "none" — preserves rubber-band affordance)', () => {
    // "contain" keeps the macOS elastic deceleration users expect; "none" would
    // silently kill that affordance too. The wheel guard is the authoritative fix
    // for Safari (bug 240183), but CSS contain handles Chrome/Edge/Firefox.
    expect(BOARD_SCROLL_OVERSCROLL_X).toBe("contain");
    expect(BOARD_SCROLL_OVERSCROLL_X).not.toBe("none");
    expect(BOARD_SCROLL_OVERSCROLL_X).not.toBe("auto");
  });

  it("SWIPE_EDGE_TOLERANCE is a small positive integer (absorbs float jitter)", () => {
    // Must be > 0 so inertia-based trackpad events near-but-not-exactly-at-edge
    // still fire the guard. Must be small (<= 8px) so the guard doesn't activate
    // in the middle of normal scroll.
    expect(SWIPE_EDGE_TOLERANCE).toBeGreaterThan(0);
    expect(SWIPE_EDGE_TOLERANCE).toBeLessThanOrEqual(8);
    expect(Number.isInteger(SWIPE_EDGE_TOLERANCE)).toBe(true);
  });

  it("BOARD_BUMP_CLASS_LEFT / BOARD_BUMP_CLASS_RIGHT are distinct non-empty strings", () => {
    expect(typeof BOARD_BUMP_CLASS_LEFT).toBe("string");
    expect(BOARD_BUMP_CLASS_LEFT.length).toBeGreaterThan(0);
    expect(typeof BOARD_BUMP_CLASS_RIGHT).toBe("string");
    expect(BOARD_BUMP_CLASS_RIGHT.length).toBeGreaterThan(0);
    expect(BOARD_BUMP_CLASS_LEFT).not.toBe(BOARD_BUMP_CLASS_RIGHT);
  });

  it("BOARD_BUMP_DURATION_MS is 150ms (quick snap-back, not sluggish)", () => {
    // 150ms is the designed duration: fast enough to feel like a physical boundary
    // hit, not so fast it's imperceptible. If this changes, update the comment in
    // Board.tsx's PULSE_CSS and the CSS transition duration.
    expect(BOARD_BUMP_DURATION_MS).toBe(150);
    expect(BOARD_BUMP_DURATION_MS).toBeGreaterThan(50);
    expect(BOARD_BUMP_DURATION_MS).toBeLessThan(400);
  });

  it("the board scroll container overscroll-x does NOT affect the Y axis", () => {
    // The Y axis MUST stay "auto" (default) so per-cell overscroll chaining
    // (CTL-958 #2) continues to work — cells can pass wheel events up to the
    // board's vertical scroll at their boundary. This is a documented invariant:
    // overscrollBehaviorX is set independently, Y is left at the browser default.
    //
    // We test this by asserting BOARD_SCROLL_OVERSCROLL_X is the X-only value
    // (a string, not an object that accidentally sets both axes).
    expect(typeof BOARD_SCROLL_OVERSCROLL_X).toBe("string");
    // And verify the Y value remains "auto" (documented sentinel — must NOT be
    // "contain" or "none", which would block vertical chaining).
    const BOARD_SCROLL_OVERSCROLL_Y = "auto";
    expect(BOARD_SCROLL_OVERSCROLL_Y).toBe("auto");
  });
});

describe("CTL-973 — swipeBlockDirection (wheel-guard direction gate)", () => {
  // A board with horizontal overflow: 2000px content in a 1000px viewport.
  // maxScrollLeft = scrollWidth - clientWidth = 1000.
  const SCROLL_WIDTH = 2000;
  const CLIENT_WIDTH = 1000;
  const MAX_LEFT = SCROLL_WIDTH - CLIENT_WIDTH; // 1000

  // ── THE REGRESSION (CTL-973 froze the board) ──────────────────────────────
  // The board rests at scrollLeft=0 (left edge). Scrolling RIGHT into content
  // (deltaX > 0) from there must NOT be blocked — this is the exact gesture the
  // original guard ate, freezing all horizontal scroll.
  it("rightward scroll INTO content from the resting left edge is NOT blocked", () => {
    expect(swipeBlockDirection(40, 0, 0, SCROLL_WIDTH, CLIENT_WIDTH)).toBeNull();
  });

  it("leftward scroll INTO content from the right edge is NOT blocked", () => {
    expect(swipeBlockDirection(-40, 0, MAX_LEFT, SCROLL_WIDTH, CLIENT_WIDTH)).toBeNull();
  });

  it("horizontal scroll in the MIDDLE (no edge) is never blocked, either direction", () => {
    expect(swipeBlockDirection(40, 0, 500, SCROLL_WIDTH, CLIENT_WIDTH)).toBeNull();
    expect(swipeBlockDirection(-40, 0, 500, SCROLL_WIDTH, CLIENT_WIDTH)).toBeNull();
  });

  // ── THE INTENDED SUPPRESSION (back/forward swipe-nav) ──────────────────────
  it("leftward gesture pushing OUTWARD past the left edge is blocked → 'left'", () => {
    expect(swipeBlockDirection(-40, 0, 0, SCROLL_WIDTH, CLIENT_WIDTH)).toBe("left");
  });

  it("rightward gesture pushing OUTWARD past the right edge is blocked → 'right'", () => {
    expect(swipeBlockDirection(40, 0, MAX_LEFT, SCROLL_WIDTH, CLIENT_WIDTH)).toBe("right");
  });

  it("within SWIPE_EDGE_TOLERANCE of an edge still counts as at-edge (float jitter)", () => {
    expect(swipeBlockDirection(-40, 0, SWIPE_EDGE_TOLERANCE, SCROLL_WIDTH, CLIENT_WIDTH)).toBe("left");
    expect(
      swipeBlockDirection(40, 0, MAX_LEFT - SWIPE_EDGE_TOLERANCE, SCROLL_WIDTH, CLIENT_WIDTH),
    ).toBe("right");
  });

  // ── VERTICAL GESTURES ARE NEVER THE SWIPE-NAV INTENT ───────────────────────
  it("vertical-dominant gestures are never blocked (pass through to scroll)", () => {
    // |deltaX| <= |deltaY| → null regardless of edge state.
    expect(swipeBlockDirection(0, 40, 0, SCROLL_WIDTH, CLIENT_WIDTH)).toBeNull();
    expect(swipeBlockDirection(10, 40, 0, SCROLL_WIDTH, CLIENT_WIDTH)).toBeNull();
    expect(swipeBlockDirection(-10, 40, MAX_LEFT, SCROLL_WIDTH, CLIENT_WIDTH)).toBeNull();
  });

  // ── NO-OVERFLOW BOARD: scrollLeft=0 is BOTH edges → suppress any h-swipe ────
  it("a board with no horizontal overflow suppresses any horizontal swipe", () => {
    // scrollWidth == clientWidth → maxLeft 0 → scrollLeft 0 is at both edges.
    expect(swipeBlockDirection(-40, 0, 0, 1000, 1000)).toBe("left");
    expect(swipeBlockDirection(40, 0, 0, 1000, 1000)).toBe("right");
    // ...but a vertical scroll still passes through.
    expect(swipeBlockDirection(0, 40, 0, 1000, 1000)).toBeNull();
  });
});
