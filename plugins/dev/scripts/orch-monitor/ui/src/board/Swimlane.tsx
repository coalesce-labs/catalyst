// Swimlane.tsx — generalized row swimlanes (BOARD3 / CTL-907), reworked into a
// SHARED-HEADER · SINGLE-SCROLL board (CTL-950), refined to Linear's nuanced
// scroll UX (CTL-958), and protected from browser back/forward swipe hijack
// (CTL-973).
//
// BEFORE (CTL-907): each swimlane rendered its OWN full TicketBoard — its own
// repeated column-header row AND its own horizontal overflow. Headers repeated
// per group, columns never aligned across groups, and every group had its own
// scrollbar ("confusing fast").
//
// NOW (CTL-950, Linear-style): ONE sticky column-header row at the very top
// spanning the full board width; the swimlane GROUPS render as horizontal
// section bands BELOW it, each a sticky group-label divider row followed by that
// group's cards laid into the SAME shared column grid. ALL groups share ONE
// horizontal scroll axis (a single overflow-x at the board level) so scrolling
// moves every group's columns together and they stay vertically aligned — EXACTLY
// one horizontal scrollbar, at the bottom. axis="none" collapses to the single
// shared-header column board (one synthetic lane, no group label).
//
// CTL-958 REFINEMENTS (Linear-style scroll UX):
//   1. DUAL-STICKY GROUP LABEL: the group label chip (dot + name + count) is sticky
//      on BOTH axes — top:HEADER_H (vertical) AND left:0 (horizontal). The outer
//      row band (the full-width divider stripe) stays sticky-top only; the CHIP
//      inside it adds left:0 so the group name stays pinned to the board's left
//      edge during horizontal scroll, exactly as observed on Linear's live board.
//      Column headers are sticky-top only (they scroll horizontally with columns).
//   2. CONSTRAINED PER-CELL HEIGHT + OVERSCROLL CHAINING: when multiple groups are
//      visible (axis !== none AND laneCount > 1), each (group × column) cell becomes
//      a vertical scroll container — overflow-y:auto with a per-lane max-height.
//      CTL-1010: that cap is now MEASURED + WATER-FILLED per lane (useLaneCellHeights
//      → computeLaneHeights) so the lanes fill the FULL board height instead of a
//      flat 300px cap — the 300px is now only the pre-measurement first-frame
//      fallback. Critically, overscroll-behavior is NOT set to "contain" — the
//      default "auto" lets wheel events chain to the board's vertical scroll once the
//      cell reaches its boundary (revealing the next group / page-scrolling in the
//      degraded many-lane case). A short/empty cell passes the wheel straight to the
//      board. The board remains the single both-axes scroll container; groups stack
//      vertically inside it in normal document flow (no flex wrappers — the
//      ChartCard flex-collapse trap is structurally avoided).
//   3. axis="none" (single flat board): no group cells, no height constraint, the
//      board scrolls normally. A single group (laneCount === 1) on a real axis
//      also skips the height constraint so one lane doesn't get a tiny scroll box.
//
// CTL-973 SWIPE FIX — prevents browser back/forward navigation on 2-finger swipe:
//   Layer 1 — CSS: `overscroll-behavior-x: contain` on the scroll container. The Y
//     axis is left at "auto" (default) so per-cell overscroll chaining (CTL-958 #2)
//     is unaffected. `contain` keeps the native rubber-band deceleration on Chrome/
//     Edge/Firefox; `none` would silently kill that affordance. CAVEAT: WebKit bug
//     240183 means `contain` does NOT prevent the two-finger history swipe in macOS
//     Safari — the wheel guard (Layer 2) is the authoritative cross-browser fix.
//   Layer 2 — JS wheel guard: a non-passive `wheel` listener on the scroll container.
//     When `|deltaX| > |deltaY|` (primarily horizontal) AND the container is at its
//     left/right edge (2px tolerance for float jitter), `e.preventDefault()` blocks
//     the browser's swipe-navigation intent. Must be `{ passive: false }` — browsers
//     default wheel to passive:true which makes preventDefault() a no-op.
//   Layer 3 — Bump affordance: edge shadow gradient (CSS, degrades in Safari) + a
//     subtle `translateX` nudge when the wheel guard fires at the edge. The nudge is
//     gated on `prefers-reduced-motion: no-preference`; the shadow is static and
//     always shown.
//
// The grouping logic itself still lives in the pure, unit-tested board-grouping.ts
// (buildLanes / showLaneChrome); this file is the presentational shell that lays
// the lanes into one CSS grid. Hand-rolled inline styles per DESIGN.md, reusing
// the shared `C` token object + the `.catalyst-live-dot` pulse.
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence } from "motion/react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { C, LIVE } from "./board-tokens";
import {
  buildLanes,
  showLaneChrome,
  singleLaneHint,
  type GroupBy,
  type HostLiveness,
  type Lane,
  type GroupableEntity,
} from "./board-grouping";
import { useRepoIconMap } from "./repo-icon-context";
import { groupIconSrc } from "./entity-icon";
import { computeLaneHeights, LANE_MIN_CELL_H } from "./lane-heights";
import type { Density } from "./prefs-store";

// ── shared geometry ──────────────────────────────────────────────────────────
// One column track is 300px (the legacy Column width), with a 16px gutter — so
// the header cells, the group-label divider, and every lane cell sit on the SAME
// grid tracks and scroll as one. The board height reads the shell --cat-board-vh
// var minus the subhead offset, exactly as the prior BoardScroll did.
const COL_W = 300;

// ── CTL-973 swipe-fix constants ───────────────────────────────────────────────
// Exported for test assertions (see swimlane-scroll.test.ts).

/** The overscroll-behavior-x value on the board scroll container (X axis only).
 *  "contain" keeps the macOS rubber-band elastic deceleration while blocking the
 *  browser's back/forward navigation intent. "none" would kill the rubber-band.
 *  NOTE: Safari bug 240183 means this alone is insufficient — the wheel guard
 *  (useBoardSwipeGuard) is the authoritative cross-browser fix. */
export const BOARD_SCROLL_OVERSCROLL_X = "contain" as const;

/** Edge tolerance (px) for the wheel guard boundary check. Absorbs floating-point
 *  jitter from inertia-based trackpad scrolling so the guard fires reliably. */
export const SWIPE_EDGE_TOLERANCE = 2;

/** CSS class applied to the board container for the `translateX` bump nudge when
 *  the wheel guard fires at the left/right edge. Gated on prefers-reduced-motion. */
export const BOARD_BUMP_CLASS_LEFT = "cat-board-bump-left";
export const BOARD_BUMP_CLASS_RIGHT = "cat-board-bump-right";

/** Duration (ms) the bump class is held before being removed. */
export const BOARD_BUMP_DURATION_MS = 150;

/** Pure decision for the wheel guard: should this horizontal wheel gesture be
 *  blocked (to suppress the browser's swipe-to-navigate), and in which direction?
 *
 *  Returns "left"/"right" when the gesture pushes OUTWARD past the corresponding
 *  edge — the only case that is a back/forward-navigation intent — and `null`
 *  otherwise (including every scroll INTO content, which must pass through to the
 *  browser). The board rests at scrollLeft=0 (the left edge), so gating on
 *  direction here is what keeps normal rightward scrolling alive; CTL-973's
 *  original guard blocked every at-edge horizontal wheel and froze the board.
 *
 *  When the board has no horizontal overflow, scrollLeft=0 is simultaneously both
 *  edges, so any horizontal swipe is outward and is (correctly) suppressed. */
export function swipeBlockDirection(
  deltaX: number,
  deltaY: number,
  scrollLeft: number,
  scrollWidth: number,
  clientWidth: number,
  tolerance: number = SWIPE_EDGE_TOLERANCE,
): "left" | "right" | null {
  // Vertical-dominant gestures are never the swipe-nav intent — let them scroll.
  if (Math.abs(deltaX) <= Math.abs(deltaY)) return null;
  const atLeft = scrollLeft <= tolerance;
  const atRight = scrollLeft >= scrollWidth - clientWidth - tolerance;
  if (atLeft && deltaX < 0) return "left";
  if (atRight && deltaX > 0) return "right";
  return null;
}
const COL_GAP = 16;
const PAD_X = 16;
// Sticky offset for the group-label row — it pins just below the column header
// (header content + its vertical padding + the 1px rule ≈ 44px).
const HEADER_H = 44;
// CTL-1010: vertical chrome a LaneCardsRow adds around its cells — the row's
// `padding: 2px top + 16px bottom`. Subtracted per lane when computing the
// available cell-area height so the water-fill budget is exact (no magic fudge).
export const ROW_PAD_V = 18;
// CTL-958: CSS variable name for the per-cell max-height knob.
// CTL-1010: this var/default is now ONLY the PRE-MEASUREMENT fallback applied on
// the very first frame before useLaneCellHeights has measured the lanes; the real
// caps are measured + water-filled per lane (computeLaneHeights). The "~2.6 cards"
// rationale is dead — 300px is just a safe one-frame placeholder (and the value the
// swimlane-scroll contract test still pins).
// Exported for tests.
export const LANE_CELL_MAX_VAR = "--lane-cell-max";
export const LANE_CELL_MAX_DEFAULT = "300px";

/** One shared header column — the lens phase/linear column the whole board aligns
 *  to. `count` / `live` are totals across ALL lanes (the header chip + live dot). */
export interface SharedColumn {
  key: string;
  label: string;
  c: string;
  count: number;
  live: number;
}

/** One lane's cell for one column: the count + live data + the rendered cards. */
export interface LaneCell {
  count: number;
  live: number;
  cards: ReactNode;
}

// ── the single sticky column-header row ──────────────────────────────────────
// position:sticky top:0 — pinned at the very top of the shared scroll so the
// phase columns stay visible while the lanes scroll vertically; it scrolls
// horizontally WITH the lanes (it lives inside the same overflow-x container).
function ColumnHeaderRow({ columns }: { columns: SharedColumn[] }) {
  return (
    <div
      // CTL-1010: tagged so useLaneCellHeights can measure the real header height
      // (offsetHeight) instead of relying on the HEADER_H magic constant.
      data-board-colheader="true"
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(${columns.length}, ${COL_W}px)`,
        gap: COL_GAP,
        padding: `8px ${PAD_X}px 10px`,
        position: "sticky",
        top: 0,
        zIndex: 3,
        background: C.s0,
        borderBottom: `1px solid ${C.borderSubtle}`,
        width: "max-content",
      }}
    >
      {columns.map((col) => (
        <div key={col.key} style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ width: 9, height: 9, borderRadius: "50%", background: col.c, flex: "0 0 auto" }} />
          <span style={{ fontSize: 13, fontWeight: 600, color: C.fg, letterSpacing: 0.2 }}>{col.label}</span>
          <span style={{ fontFamily: C.mono, fontVariantNumeric: "tabular-nums", fontSize: 11, color: C.fgMuted, background: C.s3, padding: "1px 7px", borderRadius: 9 }}>{col.count}</span>
          {col.live > 0 && (
            <span title={`${col.live} worker${col.live > 1 ? "s" : ""} live in this phase`} style={{ display: "inline-flex", alignItems: "center", gap: 4, fontFamily: C.mono, fontSize: 11, color: LIVE }}>
              <span className="catalyst-live-dot" style={{ width: 7, height: 7, borderRadius: "50%", background: LIVE, display: "inline-block" }} />{col.live} live
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

// ── a sticky group-label divider row ─────────────────────────────────────────
// CTL-950: the outer band spans the full board width and is sticky-top (pins just
// below the column header) so the group label holds position during vertical scroll.
//
// CTL-958 DUAL-STICKY: the CHIP (dot + name + count + hint) inside the band is
// ALSO sticky-left:0 so it stays pinned to the board's LEFT edge during horizontal
// scroll. Linear's behavior (verified 2026-06-10): after scrolling the board 700px
// right the "ADVA" label held at the left edge while column headers scrolled away.
// The outer band's full-width background scrolls, the chip does not.
//
// INVARIANT: cyan == live ONLY. degraded → amber, offline → muted (NEVER red —
// red is reserved for stuck/failed). null (non-host axis / no overlay) → blue, no
// liveness signal.
function GroupLabelRow({
  label,
  count,
  live,
  hint,
  iconSrc,
}: {
  label: string;
  count: number;
  live: Lane<unknown>["live"];
  hint: string | null;
  iconSrc?: string | null;
}) {
  const isLive = live === "live";
  const dotColor = isLive ? LIVE : live === "degraded" ? C.yellow : live === "offline" ? C.fgDim : C.blue;
  return (
    // Outer band: sticky-TOP only — holds its row position during vertical scroll;
    // scrolls horizontally with the column grid so the background fills the full width.
    // CTL-1010: tagged so useLaneCellHeights subtracts each lane's REAL label-band
    // height (offsetHeight) from the available cell-area budget (no magic constant).
    <div
      data-lane-label-band="true"
      style={{
        position: "sticky",
        top: HEADER_H,
        zIndex: 2,
        background: C.s0,
        width: "max-content",
        minWidth: "100%",
      }}
    >
      {/* Inner chip: ALSO sticky-LEFT:0 — pins the label to the board's left edge
          during horizontal scroll (the dual-sticky behavior). The chip has its own
          background so it paints over the band behind it as it holds position. */}
      <div
        data-swimlane-label="true"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          padding: `10px ${PAD_X}px 8px`,
          position: "sticky",
          left: 0,
          zIndex: 3,
          background: C.s0,
        }}
      >
        {iconSrc ? (
          <img src={iconSrc} alt="" aria-hidden
            style={{ width: 14, height: 14, borderRadius: 4, objectFit: "contain", flex: "0 0 auto" }} />
        ) : (
          <span
            className={isLive ? "catalyst-live-dot" : undefined}
            style={{ width: 9, height: 9, borderRadius: "50%", background: dotColor, display: "inline-block", flex: "0 0 auto" }}
          />
        )}
        <span style={{ fontFamily: C.mono, fontSize: 13, fontWeight: 700, color: C.fg }}>{label}</span>
        <span style={{ fontFamily: C.mono, fontVariantNumeric: "tabular-nums", fontSize: 11, color: C.fgMuted, background: C.s3, padding: "1px 7px", borderRadius: 9 }}>{count}</span>
        {hint && (
          <span style={{ fontSize: 11, color: C.fgMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{hint}</span>
        )}
        {live === "offline" && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span style={{ fontFamily: C.mono, fontSize: 10, color: C.fgDim }}>offline</span>
            </TooltipTrigger>
            <TooltipContent>No heartbeat within the liveness grace — last-synced truth shown (CTL-866)</TooltipContent>
          </Tooltip>
        )}
      </div>
    </div>
  );
}

// ── one lane's cards laid into the shared column grid ────────────────────────
// Each cell is its own vertical column (the cards stack); the cell is a grid
// track aligned with the shared header. An empty cell shows the dashed "—"
// placeholder so the lane reads as "nothing in this phase here" and the columns
// stay visibly aligned across lanes.
//
// CTL-958: when `constrainCells` is true each cell becomes a vertical scroll
// container — overflow-y:auto with a per-lane max-height. The cell's
// overscroll-behavior is left at the browser default ("auto") intentionally:
// this is the standard chaining behavior where wheel events that reach the
// cell's scroll boundary are passed up to the board's vertical scroll (revealing
// the next group / page-scrolling in the degraded case). "contain" would block
// that hand-off — do NOT set it. Short/empty cells (not independently scrollable)
// pass the wheel straight to the board with no extra config needed.
//
// CTL-1010: the cap is per-lane, MEASURED + WATER-FILLED (cellMax from
// useLaneCellHeights → computeLaneHeights):
//   • `undefined` (unmeasured first frame) → var(--lane-cell-max, 300px) fallback;
//   • `null` (alloc ≥ demand) → no maxHeight (uncapped — shows everything);
//   • number → that px cap (the lane's water-fill share).
// The lane row carries `data-lane-key` (matched by the hook) and constrained cells
// add className="cat-scroll" so internal scrollbars use the existing thin 9px
// themed idiom (Board.tsx PULSE_CSS). No new affordances (no fades, no "+N more").
function LaneCardsRow({
  cells,
  laneKey,
  constrainCells = false,
  cellMax,
}: {
  cells: LaneCell[];
  laneKey?: string;
  constrainCells?: boolean;
  cellMax?: number | null;
}) {
  return (
    <div
      data-lane-key={laneKey}
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(${cells.length}, ${COL_W}px)`,
        gap: COL_GAP,
        padding: `2px ${PAD_X}px 16px`,
        alignItems: "start",
        width: "max-content",
      }}
    >
      {cells.map((cell, i) => (
        <div
          key={i}
          data-lane-cell="true"
          className={constrainCells ? "cat-scroll" : undefined}
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 8,
            minWidth: 0,
            // CTL-958 / CTL-1010: per-cell constrained height with overscroll
            // chaining. Only applied when multiple groups are present
            // (constrainCells=true). The cap is the lane's measured water-fill share.
            ...(constrainCells
              ? {
                  overflowY: "auto",
                  // cellMax === undefined → pre-measurement fallback var;
                  // cellMax === null → uncapped; number → that px cap.
                  ...(cellMax === undefined
                    ? { maxHeight: `var(${LANE_CELL_MAX_VAR}, ${LANE_CELL_MAX_DEFAULT})` }
                    : cellMax === null
                      ? {}
                      : { maxHeight: cellMax }),
                  // overscroll-behavior: "auto" is the default — chains to the
                  // parent board scroll at the cell boundary. Explicit for clarity.
                  overscrollBehavior: "auto",
                }
              : {}),
          }}
        >
          {cell.count === 0 ? (
            <div style={{ color: C.fgDim, fontSize: 11.5, padding: "10px 0", border: `1px dashed ${C.borderSubtle}`, borderRadius: 8, textAlign: "center" }}>—</div>
          ) : (
            // CTL-952: AnimatePresence enables enter/exit animations on the motion
            // card elements inside (TicketCard / WorkerCard). Cards moving between
            // columns use `layoutId` on motion.div so position is animated directly
            // rather than exit + re-enter. `mode="popLayout"` keeps the column
            // height stable while a card is mid-exit (does not hold layout open).
            <AnimatePresence mode="popLayout" initial={false}>
              {cell.cards}
            </AnimatePresence>
          )}
        </div>
      ))}
    </div>
  );
}

// ── CTL-973: wheel guard + bump affordance ────────────────────────────────────
// Attaches a non-passive `wheel` listener to `scrollRef.current`. When the gesture
// is primarily horizontal (|deltaX| > |deltaY|) AND the container is at its left or
// right scroll boundary (within SWIPE_EDGE_TOLERANCE px), calls e.preventDefault()
// to block the browser's swipe-navigation intent, then briefly applies the bump
// class to `bumpRef.current` for the translateX nudge affordance.
//
// Must use `{ passive: false }` — browsers default wheel listeners to passive:true
// which silently ignores preventDefault(). Cleans up on unmount.
function useBoardSwipeGuard(
  scrollRef: React.RefObject<HTMLDivElement | null>,
  bumpRef: React.RefObject<HTMLDivElement | null>,
): void {
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let bumpTimer: ReturnType<typeof setTimeout> | null = null;

    const onWheel = (e: WheelEvent) => {
      const { scrollLeft, scrollWidth, clientWidth } = el;
      // Block ONLY a horizontal gesture pushing outward past an edge (swipe-nav
      // intent). Scrolling into content — including rightward from the board's
      // default scrollLeft=0 resting position — returns null and passes through.
      const dir = swipeBlockDirection(e.deltaX, e.deltaY, scrollLeft, scrollWidth, clientWidth);
      if (dir === null) return;
      e.preventDefault();
      // Bump affordance: apply the class, clear after BOARD_BUMP_DURATION_MS.
      const bump = bumpRef.current;
      if (bump) {
        const cls = dir === "left" ? BOARD_BUMP_CLASS_LEFT : BOARD_BUMP_CLASS_RIGHT;
        bump.classList.add(cls);
        if (bumpTimer) clearTimeout(bumpTimer);
        bumpTimer = setTimeout(() => {
          bump.classList.remove(cls);
          bumpTimer = null;
        }, BOARD_BUMP_DURATION_MS);
      }
    };

    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("wheel", onWheel);
      if (bumpTimer) clearTimeout(bumpTimer);
    };
  }, [scrollRef, bumpRef]);
}

// ── CTL-1010: measure each lane's content + water-fill its cell-area height ────
// Returns a Map<laneKey, number|null> of the per-lane cell max-height cap (null =
// uncapped), or `null` while unmeasured (first frame). SwimlaneBoard threads each
// lane's value down to its LaneCardsRow as `cellMax`.
//
// HOW IT MEASURES (no feedback loop): for each `[data-lane-key]` row, the lane's
// DEMAND is the ceil of the max `scrollHeight` over its `[data-lane-cell]` children.
// `scrollHeight` reports the cell's FULL content height INDEPENDENT of the applied
// max-height cap — so applying a cap never changes the measurement, and re-measuring
// is stable (no oscillation). AVAIL is the scroller's clientHeight minus the real
// (measured) column-header height, minus the sum of the real lane label-band
// heights, minus laneCount × ROW_PAD_V (each LaneCardsRow's 2px+16px vertical pad).
//
// Runs in useLayoutEffect (pre-paint → no flicker) on EVERY render, plus a
// ResizeObserver on the scroller (viewport / footer resize bumps a counter). setState
// is skipped when every value is within EPSILON px of the current map (absorbs
// popLayout / motion jitter so we don't thrash).
const MEASURE_EPSILON = 2;

function useLaneCellHeights(
  scrollRef: React.RefObject<HTMLDivElement | null>,
  laneKeys: string[],
  constrainCells: boolean,
  density: Density,
): Map<string, number | null> | null {
  const [allocs, setAllocs] = useState<Map<string, number | null> | null>(null);
  // ResizeObserver bumps this so the layout effect re-measures on viewport resize.
  const [resizeTick, setResizeTick] = useState(0);
  const lanesKey = laneKeys.join(" ");

  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller || !constrainCells) {
      // Clear any stale caps when the constraint is off (single lane / axis=none).
      setAllocs((prev) => (prev === null ? prev : null));
      return;
    }

    const laneEls = Array.from(
      scroller.querySelectorAll<HTMLElement>("[data-lane-key]"),
    );
    if (laneEls.length === 0) {
      setAllocs((prev) => (prev === null ? prev : null));
      return;
    }

    // DEMAND per lane: ceil(max scrollHeight over its cells). scrollHeight reads
    // full content regardless of the applied cap → no feedback loop.
    const keys: string[] = [];
    const demands: number[] = [];
    for (const laneEl of laneEls) {
      const key = laneEl.getAttribute("data-lane-key") ?? "";
      const cells = Array.from(
        laneEl.querySelectorAll<HTMLElement>("[data-lane-cell]"),
      );
      let demand = 0;
      for (const cell of cells) demand = Math.max(demand, cell.scrollHeight);
      keys.push(key);
      demands.push(Math.ceil(demand));
    }

    // AVAIL: scroller cell-area height. Measure the REAL chrome (no magic numbers):
    // clientHeight − colHeader.offsetHeight − Σ(labelBand.offsetHeight) − laneCount×ROW_PAD_V.
    const colHeaderEl = scroller.querySelector<HTMLElement>("[data-board-colheader]");
    const labelBandEls = Array.from(
      scroller.querySelectorAll<HTMLElement>("[data-lane-label-band]"),
    );
    const colHeaderH = colHeaderEl?.offsetHeight ?? 0;
    const labelBandH = labelBandEls.reduce((sum, el) => sum + el.offsetHeight, 0);
    const avail =
      scroller.clientHeight - colHeaderH - labelBandH - laneEls.length * ROW_PAD_V;

    const minH = LANE_MIN_CELL_H(density);
    const caps = computeLaneHeights(demands, Math.max(0, avail), minH);

    const next = new Map<string, number | null>();
    keys.forEach((k, i) => next.set(k, caps[i]));

    // Skip setState when nothing meaningfully changed (epsilon absorbs jitter).
    setAllocs((prev) => {
      if (prev && prev.size === next.size) {
        let same = true;
        for (const [k, v] of next) {
          if (!prev.has(k)) {
            same = false;
            break;
          }
          const p = prev.get(k) ?? null;
          if (v === null || p === null) {
            if (v !== p) {
              same = false;
              break;
            }
          } else if (Math.abs(v - p) > MEASURE_EPSILON) {
            same = false;
            break;
          }
        }
        if (same) return prev;
      }
      return next;
    });
    // Re-run every render (deps below include the lane set + resize tick); the
    // measurement is idempotent so a no-op render is cheap (setState is skipped).
  });

  // ResizeObserver on the scroller → bump the resize tick to force a re-measure.
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller || !constrainCells) return;
    const ro = new ResizeObserver(() => setResizeTick((t) => t + 1));
    ro.observe(scroller);
    return () => ro.disconnect();
  }, [scrollRef, constrainCells, lanesKey]);

  // Touch resizeTick so the layout effect re-runs when the observer fires (the
  // effect has no dep array, so this is belt-and-suspenders / lint clarity).
  void resizeTick;

  return allocs;
}

/**
 * SwimlaneBoard — the shared-header, single-scroll swimlane board (CTL-950),
 * refined to Linear's nuanced scroll UX (CTL-958).
 *
 * `columns` is the SINGLE shared header column set (derived once over EVERY lane
 * combined by the caller). `deriveLane(laneItems)` distributes ONE lane's items
 * across those columns into LaneCells (aligned 1:1, empty cells kept). axis="none"
 * is the identity collapse: one synthetic lane, the shared header, no group label.
 *
 * ALL lanes live inside ONE overflow-x:auto · overflow-y:auto container, so the
 * column header + every lane's cells scroll together on one horizontal axis and
 * stay vertically aligned — exactly one horizontal scrollbar at the bottom.
 *
 * CTL-958 scroll refinements:
 *   - Group label chips are dual-sticky (top + left), pinning the label to the
 *     board's left edge during horizontal scroll.
 *   - When multiple groups are active (axis !== none AND laneCount > 1), each
 *     (group × column) cell is height-constrained with overscroll-behavior:auto
 *     so wheel events chain to the board's vertical scroll at the cell boundary.
 *   - axis="none" and single-group boards scroll normally (no cell constraint).
 *
 * `fill`: standalone fills the shell board-var height; embedded fills its inset
 * slot (the var resolves to 100% there).
 */
export function SwimlaneBoard<T extends GroupableEntity>({
  items,
  groupBy,
  fill,
  embedded = false,
  liveness,
  columns,
  deriveLane,
  entityNoun = "ticket",
  density = "comfortable",
}: {
  items: T[];
  groupBy: GroupBy;
  fill: boolean;
  /** CTL-989: when embedded in the AppShell inset, the scroller fills its flex
   *  parent (`flex:1; minHeight:0`) instead of the standalone `100vh - 104px`
   *  magic subtraction — the board-height fix. */
  embedded?: boolean;
  liveness?: HostLiveness;
  /** the SINGLE shared header column set — same for every lane. */
  columns: SharedColumn[];
  /** distribute ONE lane's items across `columns` into aligned LaneCells. */
  deriveLane: (laneItems: T[]) => LaneCell[];
  entityNoun?: "ticket" | "worker";
  /** CTL-1010: density drives ONLY the per-lane MINIMUM (LANE_MIN_CELL_H) used by
   *  the water-fill; the real lane heights are measured from the DOM. Worker boards
   *  default to "comfortable". */
  density?: Density;
}) {
  const lanes = buildLanes(items, groupBy, liveness);
  const chrome = showLaneChrome(groupBy, lanes.length);
  // CTL-958: constrain cell heights only when multiple groups are present
  // (axis !== "none" AND laneCount > 1). A single group or no-axis board
  // scrolls normally — one lane should not get a tiny scroll box.
  const constrainCells = groupBy !== "none" && lanes.length > 1;
  const icons = useRepoIconMap();

  // CTL-973: refs for the swipe guard + bump affordance.
  // `scrollRef` points at the overflow container (the wheel listener target).
  // `bumpRef` points at the inner content div (the element that receives the
  // translateX nudge class — translating the scroll container itself would
  // cause a layout shift, so we nudge the inner block instead).
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const bumpRef = useRef<HTMLDivElement | null>(null);
  useBoardSwipeGuard(scrollRef, bumpRef);

  // CTL-1010: measure each lane's content + water-fill the available cell-area
  // height so the lanes fill the full board height (no dead band) instead of the
  // flat 300px cap. `allocs.get(laneKey)` is the per-lane cell max (null=uncapped);
  // the whole map is null on the unmeasured first frame (cells fall back to var()).
  const laneKeys = chrome ? lanes.map((l) => l.key) : [];
  const allocs = useLaneCellHeights(scrollRef, laneKeys, constrainCells, density);

  // Shadow visibility state: tracks whether the board has scrollable overflow
  // on either side, so we can show left/right edge shadows without scroll-
  // driven animations (which degrade in Safari). Updated on scroll + resize.
  const [shadows, setShadows] = useState<{ left: boolean; right: boolean }>({ left: false, right: false });
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () => {
      const { scrollLeft, scrollWidth, clientWidth } = el;
      setShadows({
        left: scrollLeft > SWIPE_EDGE_TOLERANCE,
        right: scrollLeft < scrollWidth - clientWidth - SWIPE_EDGE_TOLERANCE,
      });
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", update);
      ro.disconnect();
    };
  }, []);

  return (
    <div
      ref={scrollRef}
      className="cat-scroll cat-board-scroll"
      data-board-scroll="true"
      // CTL-989: register this scroller with TanStack Router's scroll restoration
      // (router scrollRestoration:true) so back-from-detail restores its offset
      // (both axes) per history entry — replacing the retired sessionStorage snapshot.
      data-scroll-restoration-id="board-scroll"
      style={{
        overflowX: "auto",
        overflowY: "auto",
        // CTL-973 Layer 1: contain the X overscroll to block browser swipe-navigation
        // on Chrome/Edge/Firefox. Y axis stays "auto" (default) so per-cell overscroll
        // chaining (CTL-958 #2) continues to work. Safari bug 240183 means this alone
        // is not sufficient — the wheel guard above is the authoritative fix.
        overscrollBehaviorX: BOARD_SCROLL_OVERSCROLL_X,
        overscrollBehaviorY: "auto",
        // CTL-989 board-height fix: when EMBEDDED in the AppShell inset, fill the
        // flex-column body wrapper (`flex:1; minHeight:0`) so the scroller takes
        // the full remaining height below the subhead — no dead space. Standalone
        // (board.html, full viewport) keeps the calibrated `100vh - 104px` calc.
        ...(embedded && fill
          ? { flex: 1, minHeight: 0 }
          : { height: fill ? "calc(var(--cat-board-vh, 100vh) - 104px)" : "auto" }),
        position: "relative",
      }}
    >
      {/* CTL-973 Layer 3: left/right edge shadow affordances. Rendered as
          position:sticky pseudo-elements via a wrapper div so the shadow
          travels with the viewport during scroll without needing JS. The
          gradient fades from the board background color to transparent.
          Visibility is driven by the scroll-position state. */}
      {shadows.left && (
        <div
          aria-hidden="true"
          style={{
            position: "sticky",
            left: 0,
            top: 0,
            width: 32,
            height: "100%",
            pointerEvents: "none",
            zIndex: 10,
            float: "left",
            background: `linear-gradient(to right, ${C.s0}cc 0%, transparent 100%)`,
            marginRight: -32,
          }}
        />
      )}
      {/* the inner block sizes to the full column run (max-content) so the single
          overflow-x container scrolls the header + every lane together. */}
      <div ref={bumpRef} style={{ width: "max-content", minWidth: "100%" }}>
        <ColumnHeaderRow columns={columns} />
        {/* axis="none" (and the empty-on-a-real-axis fallthrough) → one synthetic
            lane, no group label. Real axis → a sticky group-label divider per lane,
            its cards laid into the SAME shared column grid below it. */}
        {chrome ? (
          lanes.map((lane) => {
            const cells = deriveLane(lane.items);
            return (
              <Fragment key={lane.key}>
                <GroupLabelRow
                  label={lane.label}
                  count={lane.items.length}
                  live={lane.live}
                  hint={lanes.length === 1 ? singleLaneHint(groupBy, lane, entityNoun) : null}
                  iconSrc={groupIconSrc(groupBy, lane.key, icons)}
                />
                {/* CTL-1010: cellMax = this lane's measured water-fill share
                    (allocs is null on the first frame → undefined → var() fallback). */}
                <LaneCardsRow
                  cells={cells}
                  laneKey={lane.key}
                  constrainCells={constrainCells}
                  cellMax={allocs?.get(lane.key)}
                />
              </Fragment>
            );
          })
        ) : (
          <LaneCardsRow cells={deriveLane(lanes[0]?.items ?? items)} />
        )}
      </div>
      {shadows.right && (
        <div
          aria-hidden="true"
          style={{
            position: "sticky",
            right: 0,
            top: 0,
            width: 32,
            height: "100%",
            pointerEvents: "none",
            zIndex: 10,
            float: "right",
            background: `linear-gradient(to left, ${C.s0}cc 0%, transparent 100%)`,
            marginLeft: -32,
          }}
        />
      )}
    </div>
  );
}

// ── the BOARD2-popover control option set ──────────────────────────────────────
// The swimlane axis options (the STORED `Swimlane` pref values + their human
// labels), owned here alongside the renderer so the control and the grouping
// engine cannot drift — a drift guard (board-display-options-guard.test.ts) locks
// these keys to the `Swimlane` union. The display-options popover (BOARD2) renders
// them in its "Rows" SelectRow, writing straight to `prefs.swimlane`;
// the Repo axis is dropped in a single-repo workspace (filter narrows the entity
// set, swimlane=repo collapses naturally to one LABELED repo lane + hint).
// Host stays selectable single-node: picking [Host] now shows the one labeled
// lane + hint instead of silently collapsing to a bare board.
export const SWIMLANE_OPTIONS: { k: GroupBy; label: string }[] = [
  { k: "none", label: "None" },
  { k: "repo", label: "Repo" },
  { k: "team", label: "Team" },
  { k: "project", label: "Project" },
  { k: "host", label: "Host" },
];
