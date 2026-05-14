/**
 * CTL-350: Responsive HUD column widths.
 *
 * The legacy implementation hard-coded column widths via `.padEnd(N)` strings
 * in EventRow.tsx and Header.tsx, which defeated Ink's flex layout and forced
 * orchestrator IDs to truncate to `orch-adv-` on wide terminals while wasting
 * horizontal space. This module is the single source of truth for column
 * sizing — both row and header read from it so they cannot drift apart.
 *
 * Optional columns appear at successive terminal-width thresholds:
 *   STATUS    ≥100 cols   one-glyph success/failure/in-progress indicator.
 *                         3 cells wide because ⏳ (U+23F3) renders 2 cells
 *                         in most terminals and we want a trailing gutter.
 *   ORCH      ≥160 cols   catalyst.orchestrator.id (truncated to 16-18 cells
 *                         with ellipsis on long multi-ticket ids; CTL-383)
 *   WORKER    ≥180 cols   catalyst.worker.ticket
 *   EVENT-ID  ≥200 cols   first 8 chars of the per-event UUIDv4 (CTL-344)
 *
 * Numeric widths for non-optional columns are clamped between sensible min
 * and max so very narrow terminals stay readable and very wide ones don't
 * give a single column 30% of the screen.
 *
 * CTL-364: SOURCE column merged into EVENT. The single combined column shows
 * `${glyph} ${label}` where the glyph is the Nerd Font source-family icon
 * (octocat / linear ticket / broker bolt / catalyst cogs / comms speech
 * bubble / system cog) and the label is the event-name-derived friendly
 * string. EVENT width grew from a fixed 16 to a responsive 22–30 range so
 * the worst-case composed label (`{glyph} CTL-XXXX: attention`) always fits.
 */

export interface ColumnWidths {
  status: number;
  time: number;
  repo: number;
  event: number;
  ref: number;
  orch: number;
  worker: number;
  eventId: number;
  showStatus: boolean;
  showOrch: boolean;
  showWorker: boolean;
  showEventId: boolean;
}

export function computeColumnWidths(columns: number): ColumnWidths {
  const showStatus = columns >= 100;
  const showOrch = columns >= 160;
  const showWorker = columns >= 180;
  const showEventId = columns >= 200;
  return {
    status: showStatus ? 3 : 0,
    time: 10,
    repo: Math.min(14, Math.max(10, Math.floor(columns * 0.07))),
    event: Math.min(30, Math.max(22, Math.floor(columns * 0.13))),
    ref: Math.min(20, Math.max(10, Math.floor(columns * 0.08))),
    // CTL-383: cap tightened from 24 → 18. Long multi-ticket orchestrator ids
    // truncate with an ellipsis (see EventRow.tsx wrap="truncate" on the ORCH
    // <Text>); the saved cells widen DETAILS at terminals ≥240 cols.
    orch: showOrch ? Math.min(18, Math.max(16, Math.floor(columns * 0.12))) : 0,
    worker: showWorker ? 16 : 0,
    eventId: showEventId ? 10 : 0,
    showStatus,
    showOrch,
    showWorker,
    showEventId,
  };
}
