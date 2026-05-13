import { Box, Text } from "ink";
import type { CanonicalEvent } from "../../lib/canonical-event.ts";
import {
  formatTime,
  formatRepo,
  formatSource,
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
}

// CTL-350: column widths come from a shared module so EventRow and Header
// cannot drift. `<Box width flexShrink={0}>` lets Ink truncate long content
// instead of the previous `.slice(N-1).padEnd(N)` strings, which defeated
// Ink's flex layout and forced orchestrator IDs to chop at `orch-adv-` on
// wide terminals. DETAILS uses `flexGrow={1}` + `wrap="wrap"` so a long
// Groq reason wraps to multiple lines instead of being silently clipped.
export function EventRow({ event, selected, columns }: EventRowProps) {
  const color = getRowColor(event);
  // Inverse video swaps fg/bg at the terminal level (ANSI SGR 7), guaranteeing
  // contrast across themes without composing same-family fg/bg pairs.
  const inverse = selected;
  const w = computeColumnWidths(columns);

  return (
    <Box flexDirection="row">
      {w.showStatus && (
        <Box width={w.status} flexShrink={0}>
          <Text color={color} inverse={inverse}>{formatStatus(event)}</Text>
        </Box>
      )}
      <Box width={w.time} flexShrink={0}>
        <Text color={color} inverse={inverse}>{formatTime(event)}</Text>
      </Box>
      <Box width={w.repo} flexShrink={0}>
        <Text color={color} inverse={inverse}>{formatRepo(event)}</Text>
      </Box>
      <Box width={w.source} flexShrink={0}>
        <Text color={color} inverse={inverse}>{formatSource(event)}</Text>
      </Box>
      <Box width={w.event} flexShrink={0}>
        <Text color={color} inverse={inverse}>{formatEvent(event)}</Text>
      </Box>
      <Box width={w.ref} flexShrink={0}>
        <Text color={color} inverse={inverse}>{formatRef(event)}</Text>
      </Box>
      {w.showOrch && (
        <Box width={w.orch} flexShrink={0}>
          <Text color={color} inverse={inverse}>{formatOrch(event)}</Text>
        </Box>
      )}
      {w.showWorker && (
        <Box width={w.worker} flexShrink={0}>
          <Text color={color} inverse={inverse}>{formatWorker(event)}</Text>
        </Box>
      )}
      {w.showEventId && (
        <Box width={w.eventId} flexShrink={0}>
          <Text color={color} inverse={inverse} dimColor>{formatEventIdShort(event)}</Text>
        </Box>
      )}
      <Box flexGrow={1}>
        <Text color={color} inverse={inverse} wrap="wrap">{formatDetails(event)}</Text>
      </Box>
    </Box>
  );
}
