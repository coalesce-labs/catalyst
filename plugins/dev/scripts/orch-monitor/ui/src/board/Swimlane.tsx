// Swimlane.tsx — generalized row swimlanes (BOARD3 / CTL-907). Replaces the
// repo-only `Lane` that lived in Board.tsx. A swimlane is structure, not
// decoration: the header is a single quiet rule — a 9px accent/liveness dot, the
// label, a muted count chip, and (host axis only, once the liveness overlay lands)
// a heartbeat dot — riding above the lane's column board, sticky so the node/team
// label stays pinned while its columns scroll. No fills, no boxing borders, no
// chevrons; this reads as "a board of boards", never a foreign accordion.
//
// The grouping logic itself lives in the pure, unit-tested board-grouping.ts (the
// tickets-board sibling of worker-grouping.ts / queue-grouping.ts); this file is a
// thin presentational shell over it. Hand-rolled inline styles per DESIGN.md,
// reusing the shared `C` token object + the `.catalyst-live-dot` pulse.
//
// SINGLE-GROUP IDENTITY NO-OP: when buildLanes yields one lane (none, single-team,
// single-node, single-repo, or all-un-stamped-host today) SwimlaneBoard renders the
// bare column board with ZERO lane chrome — markup identical to the flat board.
import type { ReactNode } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { C, LIVE } from "./board-tokens";
import {
  buildLanes,
  type GroupBy,
  type HostLiveness,
  type Lane,
  type GroupableEntity,
} from "./board-grouping";

// ── lane header ──────────────────────────────────────────────────────────────
// INVARIANT: cyan == live ONLY. degraded → amber, offline → muted (NEVER red —
// red is reserved for stuck/failed; an offline node is shown muted, not alarmed).
// null (no overlay / non-host axis) → the neutral blue accent, no liveness signal.
function LaneHeader({
  label,
  count,
  live,
}: {
  label: string;
  count: number;
  live: Lane<unknown>["live"];
}) {
  const isLive = live === "live";
  const dotColor = isLive
    ? LIVE
    : live === "degraded"
      ? C.yellow
      : live === "offline"
        ? C.fgDim
        : C.blue;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "0 16px 8px",
        position: "sticky",
        top: 0,
        zIndex: 2,
        background: C.s0,
      }}
    >
      <span
        className={isLive ? "catalyst-live-dot" : undefined}
        style={{
          width: 9,
          height: 9,
          borderRadius: "50%",
          background: dotColor,
          display: "inline-block",
          flex: "0 0 auto",
        }}
      />
      <span style={{ fontFamily: C.mono, fontSize: 13, fontWeight: 700, color: C.fg }}>{label}</span>
      <span
        style={{
          fontFamily: C.mono,
          fontVariantNumeric: "tabular-nums",
          fontSize: 11,
          color: C.fgMuted,
          background: C.s3,
          padding: "1px 7px",
          borderRadius: 9,
        }}
      >
        {count}
      </span>
      {live === "offline" && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span style={{ fontFamily: C.mono, fontSize: 10, color: C.fgDim }}>offline</span>
          </TooltipTrigger>
          <TooltipContent>
            No heartbeat within the liveness grace — last-synced truth shown (CTL-866)
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}

/**
 * SwimlaneBoard — wraps a column-board renderer in row lanes. Generic over the
 * entity (CTL-930 forward-compat): pass tickets + a TicketBoard renderer, or
 * workers + a WorkerBoard renderer. A single resolved lane renders the body with
 * NO header (the identity no-op to the flat board). `liveness` is the optional
 * host-liveness overlay — omit it and host lanes simply carry no liveness dot.
 *
 * fill: passed straight through in the one-lane case (the column board owns the
 * shell-var height as it does today); in the N-lane case the outer wrapper scrolls
 * the page and each board renders at fill=false (auto height), exactly as the prior
 * repo-lanes branch did.
 */
export function SwimlaneBoard<T extends GroupableEntity>({
  items,
  groupBy,
  fill,
  liveness,
  renderBoard,
}: {
  items: T[];
  groupBy: GroupBy;
  fill: boolean;
  liveness?: HostLiveness;
  renderBoard: (laneItems: T[], laneFill: boolean) => ReactNode;
}) {
  const lanes = buildLanes(items, groupBy, liveness);

  // Identity no-op: zero or one lane → the bare flat board, no chrome. (Zero lanes
  // happens only when `items` is empty on a real axis — render the empty board so
  // the column scaffolding/empty-state still shows, identical to today.)
  if (lanes.length <= 1) {
    return <>{renderBoard(lanes[0]?.items ?? items, fill)}</>;
  }

  // N lanes → vertically stacked, each header + its own column board. The wrapper
  // owns the scroll (the shell --cat-board-vh var, minus the chrome offset) so the
  // sticky lane headers pin while their columns scroll.
  return (
    <div
      className="cat-scroll"
      style={{
        overflowY: "auto",
        height: "calc(var(--cat-board-vh, 100vh) - 104px)",
        paddingTop: 4,
      }}
    >
      {lanes.map((lane) => (
        <div key={lane.key} style={{ marginBottom: 14 }}>
          <LaneHeader label={lane.label} count={lane.items.length} live={lane.live} />
          {renderBoard(lane.items, false /* lanes scroll the page, not each board */)}
        </div>
      ))}
    </div>
  );
}

// ── the BOARD2-popover control option set ──────────────────────────────────────
// The swimlane axis options (the STORED `Swimlane` pref values + their human
// labels), owned here alongside the renderer so the control and the grouping
// engine cannot drift — a drift guard (board-display-options-guard.test.ts) locks
// these keys to the `Swimlane` union. The display-options popover (BOARD2) renders
// them in its reserved "Swimlanes" RadioRow, writing straight to `prefs.swimlane`;
// the Repo axis is dropped in a single-repo workspace (no lanes to draw, an
// identity no-op), and Host stays selectable single-node (picking it collapses to
// one lane, exactly like the SURF1/SURF2 node controls stay inert single-host).
export const SWIMLANE_OPTIONS: { k: GroupBy; label: string }[] = [
  { k: "none", label: "None" },
  { k: "repo", label: "Repo" },
  { k: "team", label: "Team" },
  { k: "project", label: "Project" },
  { k: "host", label: "Host" },
];
