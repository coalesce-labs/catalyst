// Swimlane.tsx — generalized row swimlanes (BOARD3 / CTL-907), reworked into a
// SHARED-HEADER · SINGLE-SCROLL board (CTL-950).
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
// The grouping logic itself still lives in the pure, unit-tested board-grouping.ts
// (buildLanes / showLaneChrome); this file is the presentational shell that lays
// the lanes into one CSS grid. Hand-rolled inline styles per DESIGN.md, reusing
// the shared `C` token object + the `.catalyst-live-dot` pulse.
import { Fragment, type ReactNode } from "react";
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

// ── shared geometry ──────────────────────────────────────────────────────────
// One column track is 300px (the legacy Column width), with a 16px gutter — so
// the header cells, the group-label divider, and every lane cell sit on the SAME
// grid tracks and scroll as one. The board height reads the shell --cat-board-vh
// var minus the subhead offset, exactly as the prior BoardScroll did.
const COL_W = 300;
const COL_GAP = 16;
const PAD_X = 16;
// Sticky offset for the group-label row — it pins just below the column header
// (header content + its vertical padding + the 1px rule ≈ 44px).
const HEADER_H = 44;

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
// Spans the full board width, sticky just BELOW the column header so the group
// name (e.g. "CTL 21") stays pinned while its cards scroll.
// INVARIANT: cyan == live ONLY. degraded → amber, offline → muted (NEVER red —
// red is reserved for stuck/failed). null (non-host axis / no overlay) → blue, no
// liveness signal.
function GroupLabelRow({
  label,
  count,
  live,
  hint,
}: {
  label: string;
  count: number;
  live: Lane<unknown>["live"];
  hint: string | null;
}) {
  const isLive = live === "live";
  const dotColor = isLive ? LIVE : live === "degraded" ? C.yellow : live === "offline" ? C.fgDim : C.blue;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: `10px ${PAD_X}px 8px`,
        position: "sticky",
        top: HEADER_H,
        zIndex: 2,
        background: C.s0,
        width: "max-content",
        minWidth: "100%",
      }}
    >
      <span
        className={isLive ? "catalyst-live-dot" : undefined}
        style={{ width: 9, height: 9, borderRadius: "50%", background: dotColor, display: "inline-block", flex: "0 0 auto" }}
      />
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
  );
}

// ── one lane's cards laid into the shared column grid ────────────────────────
// Each cell is its own vertical column (the cards stack); the cell is a grid
// track aligned with the shared header. An empty cell shows the dashed "—"
// placeholder so the lane reads as "nothing in this phase here" and the columns
// stay visibly aligned across lanes.
function LaneCardsRow({ cells }: { cells: LaneCell[] }) {
  return (
    <div
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
        <div key={i} style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
          {cell.count === 0 ? (
            <div style={{ color: C.fgDim, fontSize: 11.5, padding: "10px 0", border: `1px dashed ${C.borderSubtle}`, borderRadius: 8, textAlign: "center" }}>—</div>
          ) : (
            cell.cards
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * SwimlaneBoard — the shared-header, single-scroll swimlane board (CTL-950).
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
 * `fill`: standalone fills the shell board-var height; embedded fills its inset
 * slot (the var resolves to 100% there).
 */
export function SwimlaneBoard<T extends GroupableEntity>({
  items,
  groupBy,
  fill,
  liveness,
  columns,
  deriveLane,
  entityNoun = "ticket",
}: {
  items: T[];
  groupBy: GroupBy;
  fill: boolean;
  liveness?: HostLiveness;
  /** the SINGLE shared header column set — same for every lane. */
  columns: SharedColumn[];
  /** distribute ONE lane's items across `columns` into aligned LaneCells. */
  deriveLane: (laneItems: T[]) => LaneCell[];
  entityNoun?: "ticket" | "worker";
}) {
  const lanes = buildLanes(items, groupBy, liveness);
  const chrome = showLaneChrome(groupBy, lanes.length);

  return (
    <div
      className="cat-scroll"
      style={{
        overflowX: "auto",
        overflowY: "auto",
        height: fill ? "calc(var(--cat-board-vh, 100vh) - 104px)" : "auto",
      }}
    >
      {/* the inner block sizes to the full column run (max-content) so the single
          overflow-x container scrolls the header + every lane together. */}
      <div style={{ width: "max-content", minWidth: "100%" }}>
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
                />
                <LaneCardsRow cells={cells} />
              </Fragment>
            );
          })
        ) : (
          <LaneCardsRow cells={deriveLane(lanes[0]?.items ?? items)} />
        )}
      </div>
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
