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
 *
 * CTL-394: resolveColumns() provides a config-driven ordered column list for
 * data-driven rendering in EventRow and Header. computeColumnWidths() is
 * preserved unchanged for backward compat with existing tests.
 */

import type { HudColumnConfig, HudColumnId } from "../../lib/monitor-config.ts";
import { COLUMN_DESCRIPTORS, DEFAULT_COLUMN_ORDER } from "./columns.ts";
import type { ColumnDescriptor } from "./columns.ts";

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
  // CTL-395: explicit width so Ink writes trailing spaces and clears ghost chars
  details: number;
  showStatus: boolean;
  showOrch: boolean;
  showWorker: boolean;
}

export function computeColumnWidths(columns: number): ColumnWidths {
  const showStatus = columns >= 100;
  const showOrch = columns >= 160;
  const showWorker = columns >= 180;

  const status = showStatus ? 3 : 0;
  const time = 10;
  const repo = Math.min(14, Math.max(10, Math.floor(columns * 0.07)));
  const icon = 1;
  const event = Math.min(40, Math.max(24, Math.floor(columns * 0.18)));
  const ref = Math.min(20, Math.max(10, Math.floor(columns * 0.08)));
  // CTL-383: cap tightened from 24 → 18. Long multi-ticket orchestrator ids
  // truncate with an ellipsis (see EventRow.tsx wrap="truncate" on the ORCH
  // <Text>); the saved cells widen DETAILS at terminals ≥240 cols.
  const orch = showOrch ? Math.min(18, Math.max(16, Math.floor(columns * 0.12))) : 0;
  const worker = showWorker ? 16 : 0;

  // CTL-395: each visible column (except DETAILS) has marginRight={1}.
  // CTL-391 added icon as an always-present column, so 5 always-present columns
  // (time, repo, icon, event, ref) each contribute 1 margin.
  const marginCount = 5 // time, repo, icon, event, ref always present
    + (showStatus ? 1 : 0)
    + (showOrch ? 1 : 0)
    + (showWorker ? 1 : 0);
  const fixedTotal = status + time + repo + icon + event + ref + orch + worker + marginCount;
  const details = Math.max(20, columns - fixedTotal);

  return {
    status,
    time,
    repo,
    icon,
    event,
    ref,
    orch,
    worker,
    details,
    showStatus,
    showOrch,
    showWorker,
  };
}

export interface ResolvedColumn extends ColumnDescriptor {
  /** Resolved char width. Always > 0, including DETAILS (computed from remaining space). */
  width: number;
}

/**
 * CTL-394: Build the ordered, visible column list for a given terminal width
 * and optional user config.
 *
 * - No config (or empty array): identical to today's hardcoded column set.
 * - Config provided: iterate in config order; unknown IDs are silently skipped.
 *   DETAILS is always moved to last so width computation fills remaining space.
 */
export function resolveColumns(
  terminalCols: number,
  config?: HudColumnConfig[] | null,
): ResolvedColumn[] {
  if (!config || config.length === 0) {
    return buildDefaultColumns(terminalCols);
  }
  return buildConfigColumns(terminalCols, config);
}

function buildDefaultColumns(terminalCols: number): ResolvedColumn[] {
  const nonDetails = DEFAULT_COLUMN_ORDER
    .filter((id) => id !== "details")
    .map((id) => {
      const desc = COLUMN_DESCRIPTORS[id];
      if (!desc) return null;
      if (terminalCols < desc.minTerminalWidth) return null;
      return { ...desc, width: desc.computeWidth(terminalCols) } as ResolvedColumn;
    })
    .filter((c): c is ResolvedColumn => c !== null);

  // DETAILS width = remaining space (same formula as computeColumnWidths).
  const detailsDesc = COLUMN_DESCRIPTORS["details"];
  if (!detailsDesc) return nonDetails;
  const detailsWidth = computeColumnWidths(terminalCols).details;
  return [...nonDetails, { ...detailsDesc, width: detailsWidth }];
}

function buildConfigColumns(
  terminalCols: number,
  config: HudColumnConfig[],
): ResolvedColumn[] {
  const detailsEntry = config.find((c) => c.id === "details");
  const nonDetails = config.filter((c) => c.id !== "details");

  const resolved: ResolvedColumn[] = [];

  for (const entry of nonDetails) {
    const desc = COLUMN_DESCRIPTORS[entry.id];
    if (!desc) continue; // unknown id

    // explicit visible:true with no explicit minTerminalWidth overrides the
    // descriptor's terminal-width threshold so the user can force a column on
    // at narrow widths (e.g. force ORCH at 80 cols).
    const effectiveMinWidth =
      entry.visible === true && entry.minTerminalWidth === undefined
        ? 0
        : (entry.minTerminalWidth ?? desc.minTerminalWidth);
    if (terminalCols < effectiveMinWidth) continue;

    // In config mode, always-visible columns (minTerminalWidth === 0) default to
    // visible; threshold columns default to their descriptor's defaultVisible.
    const visibleDefault = effectiveMinWidth === 0 ? true : desc.defaultVisible;
    const visible = entry.visible ?? visibleDefault;
    if (!visible) continue;

    const width =
      entry.width !== undefined && entry.width !== "auto"
        ? entry.width
        : desc.computeWidth(terminalCols);

    resolved.push({ ...desc, width });
  }

  // Append DETAILS last, computing width from remaining terminal space.
  if (detailsEntry) {
    const desc = COLUMN_DESCRIPTORS["details"];
    if (desc) {
      const visible = detailsEntry.visible ?? true;
      if (visible) {
        const fixedTotal = resolved.reduce((sum, c) => sum + c.width, 0);
        const marginCount = resolved.length; // each non-details column has marginRight={1}
        const detailsWidth = Math.max(20, terminalCols - fixedTotal - marginCount);
        resolved.push({ ...desc, width: detailsWidth });
      }
    }
  }

  return resolved;
}

/** Convenience: does the resolved column list include an ORCH column? */
export function hasOrchColumn(resolved: ResolvedColumn[]): boolean {
  return resolved.some((c) => c.id === ("orch" as HudColumnId));
}
