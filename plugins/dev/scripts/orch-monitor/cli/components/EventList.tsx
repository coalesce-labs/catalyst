import { memo } from "react";
import { Box } from "ink";
import type { CanonicalEvent } from "../../lib/canonical-event.ts";
import { synthesizeEventId } from "../../lib/canonical-event-shared.ts";
import { EventRow } from "./EventRow.tsx";
import type { HudColumnConfig } from "../../lib/monitor-config.ts";

/**
 * Stable per-row key. event.id is non-optional in the post-CTL-344 schema,
 * but ~42k legacy records in live logs carry `id === null` — fall back to
 * synthesizeEventId for those. Matches broker pattern at index.mjs:162.
 */
export function eventRowKey(event: CanonicalEvent): string {
  return event.id ?? synthesizeEventId(event);
}

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
  // CTL-384: global wrap mode toggle forwarded to each EventRow.
  wrapMode?: 'truncate' | 'wrap';
  // CTL-394: optional user column config forwarded to each EventRow.
  columnConfig?: HudColumnConfig[] | null;
}

// CTL-473: memo wrap. `events` identity changes per new event (by design via
// useFilter), but selection moves and broker polls leave it unchanged — those
// are the cases this memo short-circuits.
function EventListImpl({
  events,
  selectedIndex,
  scrollOffset,
  visibleRows,
  columns,
  compact,
  paused = true,
  wrapMode = 'truncate',
  columnConfig,
}: EventListProps) {
  const visible = events.slice(scrollOffset, scrollOffset + visibleRows);

  return (
    <Box flexDirection="column" flexGrow={compact ? 0 : 1}>
      {visible.map((event, i) => (
        <EventRow
          key={eventRowKey(event)}
          event={event}
          selected={scrollOffset + i === selectedIndex}
          columns={columns}
          paused={paused}
          wrapMode={wrapMode}
          columnConfig={columnConfig}
        />
      ))}
    </Box>
  );
}

export const EventList = memo(EventListImpl);
EventList.displayName = "EventList";
