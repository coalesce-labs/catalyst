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
 *   ORCH      ≥160 cols   full catalyst.orchestrator.id
 *   WORKER    ≥180 cols   catalyst.worker.ticket
 *   EVENT-ID  ≥200 cols   first 8 chars of the per-event UUIDv4 (CTL-344)
 *
 * Numeric widths for non-optional columns are clamped between sensible min
 * and max so very narrow terminals stay readable and very wide ones don't
 * give a single column 30% of the screen.
 */

export interface ColumnWidths {
  status: number;
  time: number;
  repo: number;
  source: number;
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
    source: Math.min(22, Math.max(16, Math.floor(columns * 0.1))),
    event: 16,
    ref: Math.min(20, Math.max(10, Math.floor(columns * 0.08))),
    orch: showOrch ? Math.min(24, Math.max(16, Math.floor(columns * 0.12))) : 0,
    worker: showWorker ? 16 : 0,
    eventId: showEventId ? 10 : 0,
    showStatus,
    showOrch,
    showWorker,
    showEventId,
  };
}
