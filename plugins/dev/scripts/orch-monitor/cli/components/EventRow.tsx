import { memo } from "react";
import { Box, Text } from "ink";
import type { CanonicalEvent } from "../../lib/canonical-event.ts";
import { formatRef, formatOrch } from "../lib/format.ts";
import { getRowColor } from "../lib/colors.ts";
import { resolveColumns, hasOrchColumn } from "../lib/column-widths.ts";
import type { HudColumnConfig } from "../../lib/monitor-config.ts";

interface EventRowProps {
  event: CanonicalEvent;
  selected: boolean;
  columns: number;
  // CTL-351: cursor is only meaningful when the user has paused live tailing.
  // EventList passes the inverse of autoFollow so the row knows whether to
  // render an inverse-video cursor. In live mode the cursor is invisible.
  paused?: boolean;
  // CTL-384: global wrap mode toggle. Default truncate keeps each event on one
  // line; 'wrap' reflows long DETAILS content across multiple terminal lines.
  wrapMode?: 'truncate' | 'wrap';
  // CTL-394: optional user column config loaded from ~/.config/catalyst/monitor.json.
  columnConfig?: HudColumnConfig[] | null;
}

// CTL-350: column widths come from a shared module so EventRow and Header
// cannot drift. `<Box width flexShrink={0}>` lets Ink truncate long content
// instead of the previous `.slice(N-1).padEnd(N)` strings, which defeated
// Ink's flex layout and forced orchestrator IDs to chop at `orch-adv-` on
// wide terminals.
// CTL-391: ICON column carries the source-family Nerd Font glyph in its
// own 1-cell box to the left of EVENT, freeing EVENT to show the raw
// `event.name` attribute verbatim.
// CTL-395: explicit `width={w.details}` replaces `flexGrow={1}` so Ink pads
// the cell to a fixed width and writes trailing spaces over any ghost chars
// left by a prior longer string.
// CTL-416: all columns now use wrap="truncate" (via col.wrap or the ?? fallback
// in EventRow) so Ink writes exactly col.width chars per cell on every render,
// overwriting stale terminal chars when shorter content replaces longer content.
// CTL-394: columns are now data-driven via resolveColumns() — EventRow
// iterates the resolved list so custom column order/visibility/widths from
// ~/.config/catalyst/monitor.json are honoured without touching this file.
// CTL-473: memo wrap — highest single-component leverage. On every selection
// move N-2 of N rows short-circuit because `event`, `columns`, etc. for non-
// selected rows are unchanged from the previous render.
// Exported (`EventRowImpl`) so __tests__/event-row.test.tsx can introspect
// the unwrapped render output — memo's MemoExoticComponent is not callable.
export function EventRowImpl({ event, selected, columns, paused = true, wrapMode = 'truncate', columnConfig }: EventRowProps) {
  const color = getRowColor(event);
  // Inverse video swaps fg/bg at the terminal level (ANSI SGR 7), guaranteeing
  // contrast across themes without composing same-family fg/bg pairs. Hidden
  // in live mode so the cursor doesn't distract from streaming events.
  const inverse = selected && paused;
  const resolved = resolveColumns(columns, columnConfig);

  // CTL-355: when REF would render the same value as ORCH (common for
  // filter.wake.<orch-id> rows where the wake target IS the orchestrator id),
  // blank REF so the operator doesn't read the same id twice on every wide
  // row. Only takes effect when the ORCH column is visible; on narrow
  // terminals (no ORCH) REF still shows the value because there's nowhere
  // else to see it.
  const refText = formatRef(event);
  const orchText = formatOrch(event);
  const displayRef = hasOrchColumn(resolved) && refText !== "" && refText === orchText ? "" : refText;

  return (
    <Box flexDirection="row">
      {resolved.map((col) => {
        const isDetails = col.id === "details";
        const text = col.id === "ref" ? displayRef : col.format(event);
        const wrap = isDetails ? wrapMode : (col.wrap ?? "truncate");
        return (
          <Box key={col.id} width={col.width} flexShrink={0} marginRight={isDetails ? 0 : 1}>
            <Text color={color} inverse={inverse} wrap={wrap} dimColor={col.dimColor}>
              {text}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}

export const EventRow = memo(EventRowImpl);
EventRow.displayName = "EventRow";
