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
 *
 * CTL-391: SOURCE icon split back out into its own 1-cell ICON column to
 * the left of EVENT, and EVENT now carries the raw `event.name` attribute
 * (`github.pr.merged`, `filter.wake.<sessionId>`, `comms.message.posted`,
 * …) instead of a friendly label. Raw names are longer than the legacy
 * labels (`github.pr_review_comment.created` is 32 chars; `filter.wake.`
 * + 32-char sessionId is 44+) so EVENT's responsive range grows to
 * 24–40 — EVENT is now the most informative column on the row and earns
 * the extra width. Overflow still clips via `wrap="truncate"`; nothing
 * reflows.
 */

export interface ColumnWidths {
  status: number;
  time: number;
  repo: number;
  // CTL-391: 1-cell column carrying the source-family Nerd Font glyph.
  // Always rendered — when no Nerd Font is detected formatIcon returns
  // "" and the cell is visually blank, but the width stays reserved so
  // columns below the header stay aligned.
  icon: number;
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
    icon: 1,
    event: Math.min(40, Math.max(24, Math.floor(columns * 0.18))),
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
