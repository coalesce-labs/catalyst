import { Box } from "ink";
import type { CanonicalEvent } from "../../lib/canonical-event.ts";
import { EventRow } from "./EventRow.tsx";

interface EventListProps {
  events: CanonicalEvent[];
  selectedIndex: number;
  scrollOffset: number;
  visibleRows: number;
  columns: number;
  compact?: boolean;
  // CTL-351: paused = !autoFollow. Plumbed through to EventRow so the
  // selection cursor is invisible in live mode and revealed once the user
  // navigates via Up/Down (which pauses autoFollow inside useSelection).
  paused?: boolean;
}

export function EventList({
  events,
  selectedIndex,
  scrollOffset,
  visibleRows,
  columns,
  compact,
  paused = true,
}: EventListProps) {
  const visible = events.slice(scrollOffset, scrollOffset + visibleRows);

  return (
    <Box flexDirection="column" flexGrow={compact ? 0 : 1}>
      {visible.map((event, i) => (
        <EventRow
          key={`${event.ts}-${scrollOffset + i}`}
          event={event}
          selected={scrollOffset + i === selectedIndex}
          columns={columns}
          paused={paused}
        />
      ))}
    </Box>
  );
}
