import { Box, Text } from "ink";
import type { CanonicalEvent } from "../../lib/canonical-event.ts";
import {
  formatTime,
  formatRepo,
  formatSource,
  formatEvent,
  formatRef,
  formatDetails,
} from "../lib/format.ts";
import { getRowColor } from "../lib/colors.ts";

interface EventRowProps {
  event: CanonicalEvent;
  selected: boolean;
  columns: number;
}

export function EventRow({ event, selected, columns }: EventRowProps) {
  const color = getRowColor(event);
  const bg = selected ? ("blue" as const) : undefined;
  const detailsWidth = Math.max(0, columns - 8 - 12 - 20 - 14 - 14 - 5);

  return (
    <Box flexDirection="row">
      <Text color={color} backgroundColor={bg}>
        {formatTime(event).padEnd(8)}
      </Text>
      <Text color={color} backgroundColor={bg}>
        {formatRepo(event).slice(0, 11).padEnd(12)}
      </Text>
      <Text color={color} backgroundColor={bg}>
        {formatSource(event).slice(0, 19).padEnd(20)}
      </Text>
      <Text color={color} backgroundColor={bg}>
        {formatEvent(event).slice(0, 13).padEnd(14)}
      </Text>
      <Text color={color} backgroundColor={bg}>
        {formatRef(event).slice(0, 13).padEnd(14)}
      </Text>
      <Text color={color} backgroundColor={bg}>
        {formatDetails(event).slice(0, detailsWidth)}
      </Text>
    </Box>
  );
}
