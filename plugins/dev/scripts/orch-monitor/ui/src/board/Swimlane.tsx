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
// CTL-930 Phase 3: the single-lane identity no-op (no chrome for 1 lane) is
// replaced by showLaneChrome — an explicit axis ALWAYS shows the labeled header
// even for a single lane (+ a singleLaneHint inline after the count chip).
// axis="none" stays a pure identity no-op. Picking [Host] on a single-host fleet
// now shows the one labeled lane + hint instead of silently collapsing.
import type { ReactNode } from "react";
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

// ── lane header ──────────────────────────────────────────────────────────────
// INVARIANT: cyan == live ONLY. degraded → amber, offline → muted (NEVER red —
// red is reserved for stuck/failed; an offline node is shown muted, not alarmed).
// null (no overlay / non-host axis) → the neutral blue accent, no liveness signal.
function LaneHeader({
  label,
  count,
  live,
  hint,
}: {
  label: string;
  count: number;
  live: Lane<unknown>["live"];
  hint?: string | null;
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
      {hint && (
        <span style={{ fontSize: 11, color: C.fgMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {hint}
        </span>
      )}
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
 * workers + a WorkerBoard renderer.
 *
 * CTL-930 Phase 3: an explicit axis (team/project/repo/host) ALWAYS renders lane
 * chrome, even for a single lane. axis="none" keeps the classic identity no-op
 * (bare flat board, no chrome). A single lane shows the header + a singleLaneHint.
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
  entityNoun = "ticket",
}: {
  items: T[];
  groupBy: GroupBy;
  fill: boolean;
  liveness?: HostLiveness;
  renderBoard: (laneItems: T[], laneFill: boolean) => ReactNode;
  entityNoun?: "ticket" | "worker";
}) {
  const lanes = buildLanes(items, groupBy, liveness);

  // Identity no-op (axis="none" only): render the bare flat board with no chrome.
  // Zero lanes on a real axis also falls through here (empty entity set — render
  // the empty board so column scaffolding/empty-state still shows).
  if (!showLaneChrome(groupBy, lanes.length)) {
    return <>{renderBoard(lanes[0]?.items ?? items, fill)}</>;
  }

  // Explicit axis → vertically stacked, each header + its own column board. The
  // wrapper owns the scroll (the shell --cat-board-vh var, minus the chrome offset)
  // so the sticky lane headers pin while their columns scroll.
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
          <LaneHeader
            label={lane.label}
            count={lane.items.length}
            live={lane.live}
            hint={lanes.length === 1 ? singleLaneHint(groupBy, lane, entityNoun) : null}
          />
          {renderBoard(lane.items, lanes.length === 1 ? fill : false)}
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
