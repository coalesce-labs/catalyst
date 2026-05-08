import { Box } from "ink";
import type { CanonicalEvent } from "../../lib/canonical-event.ts";
import { EventRow } from "./EventRow.tsx";

interface EventListProps {
  events: CanonicalEvent[];
  selectedIndex: number;
  scrollOffset: number;
  visibleRows: number;
  columns: number;
}

export function EventList({
  events,
  selectedIndex,
  scrollOffset,
  visibleRows,
  columns,
}: EventListProps) {
  const visible = events.slice(scrollOffset, scrollOffset + visibleRows);

  return (
    <Box flexDirection="column" flexGrow={1}>
      {visible.map((event, i) => (
        <EventRow
          key={`${event.ts}-${scrollOffset + i}`}
          event={event}
          selected={scrollOffset + i === selectedIndex}
          columns={columns}
        />
      ))}
    </Box>
  );
}
