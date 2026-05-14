import { Box, Text } from "ink";
import type { CanonicalEvent } from "../../lib/canonical-event.ts";
import {
  formatTime,
  formatRepo,
  formatIcon,
  formatEvent,
  formatRef,
  formatDetails,
  formatStatus,
  formatOrch,
  formatWorker,
  formatEventIdShort,
} from "../lib/format.ts";
import { getRowColor } from "../lib/colors.ts";
import { computeColumnWidths } from "../lib/column-widths.ts";

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
}

// CTL-350: column widths come from a shared module so EventRow and Header
// cannot drift. `<Box width flexShrink={0}>` lets Ink truncate long content
// instead of the previous `.slice(N-1).padEnd(N)` strings, which defeated
// Ink's flex layout and forced orchestrator IDs to chop at `orch-adv-` on
// wide terminals.
// CTL-391: ICON column carries the source-family Nerd Font glyph in its
// own 1-cell box to the left of EVENT, freeing EVENT to show the raw
// `event.name` attribute verbatim. When no Nerd Font is detected the
// cell renders blank but its width stays reserved so columns stay
// aligned across heterogeneous rows.
// CTL-361: DETAILS uses `flexGrow={1}` + `wrap="truncate"` so an overly long
// payload hard-clips at the cell's right edge instead of reflowing onto the
// next terminal line and visually overdrawing the next event row — which is
// what happens with `wrap="wrap"` during aggressive terminal resizes when the
// React `cols` state lags the physical width. Operators who need the full
// DETAILS content open the scrollable detail pane with Enter.
// CTL-351: every fixed-width column has a 1-col right margin so the columns
// breathe and abutting cells (TIME↔REPO, EVENT↔REF) don't visually run
// together on rows with short content.
export function EventRow({ event, selected, columns, paused = true, wrapMode = 'truncate' }: EventRowProps) {
  const color = getRowColor(event);
  // Inverse video swaps fg/bg at the terminal level (ANSI SGR 7), guaranteeing
  // contrast across themes without composing same-family fg/bg pairs. Hidden
  // in live mode so the cursor doesn't distract from streaming events.
  const inverse = selected && paused;
  const w = computeColumnWidths(columns);

  // CTL-355: when REF would render the same value as ORCH (common for
  // filter.wake.<orch-id> rows where the wake target IS the orchestrator id),
  // blank REF so the operator doesn't read the same id twice on every wide
  // row. Only takes effect when the ORCH column is visible; on narrow
  // terminals (no ORCH) REF still shows the value because there's nowhere
  // else to see it.
  const refText = formatRef(event);
  const orchText = formatOrch(event);
  const displayRef = w.showOrch && refText !== "" && refText === orchText ? "" : refText;

  return (
    <Box flexDirection="row">
      {w.showStatus && (
        <Box width={w.status} flexShrink={0} marginRight={1}>
          <Text color={color} inverse={inverse}>{formatStatus(event)}</Text>
        </Box>
      )}
      <Box width={w.time} flexShrink={0} marginRight={1}>
        <Text color={color} inverse={inverse}>{formatTime(event)}</Text>
      </Box>
      <Box width={w.repo} flexShrink={0} marginRight={1}>
        <Text color={color} inverse={inverse}>{formatRepo(event)}</Text>
      </Box>
      <Box width={w.icon} flexShrink={0} marginRight={1}>
        <Text color={color} inverse={inverse}>{formatIcon(event)}</Text>
      </Box>
      <Box width={w.event} flexShrink={0} marginRight={1}>
        <Text color={color} inverse={inverse} wrap="truncate">{formatEvent(event)}</Text>
      </Box>
      <Box width={w.ref} flexShrink={0} marginRight={1}>
        <Text color={color} inverse={inverse}>{displayRef}</Text>
      </Box>
      {w.showOrch && (
        <Box width={w.orch} flexShrink={0} marginRight={1}>
          {/* CTL-383: long multi-ticket orchestrator ids reflow into a second
              terminal line without wrap="truncate", doubling row height.
              Same fix shape as EVENT (CTL-364) and DETAILS (CTL-361). */}
          <Text color={color} inverse={inverse} wrap="truncate">{orchText}</Text>
        </Box>
      )}
      {w.showWorker && (
        <Box width={w.worker} flexShrink={0} marginRight={1}>
          <Text color={color} inverse={inverse}>{formatWorker(event)}</Text>
        </Box>
      )}
      {w.showEventId && (
        <Box width={w.eventId} flexShrink={0} marginRight={1}>
          <Text color={color} inverse={inverse} dimColor>{formatEventIdShort(event)}</Text>
        </Box>
      )}
      <Box flexGrow={1}>
        <Text color={color} inverse={inverse} wrap={wrapMode}>{formatDetails(event)}</Text>
      </Box>
    </Box>
  );
}
