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
  // Inverse video swaps fg/bg at the terminal level (ANSI SGR 7), guaranteeing
  // contrast across themes without composing same-family fg/bg pairs.
  const inverse = selected;
  // Widths: time(10) repo(12) source(20) event(16) ref(10) = 68 fixed
  const detailsWidth = Math.max(0, columns - 10 - 12 - 20 - 16 - 10 - 2);

  return (
    <Box flexDirection="row">
      <Text color={color} inverse={inverse}>
        {formatTime(event).padEnd(10)}
      </Text>
      <Text color={color} inverse={inverse}>
        {formatRepo(event).slice(0, 11).padEnd(12)}
      </Text>
      <Text color={color} inverse={inverse}>
        {formatSource(event).slice(0, 19).padEnd(20)}
      </Text>
      <Text color={color} inverse={inverse}>
        {formatEvent(event).slice(0, 15).padEnd(16)}
      </Text>
      <Text color={color} inverse={inverse}>
        {formatRef(event).slice(0, 9).padEnd(10)}
      </Text>
      <Text color={color} inverse={inverse}>
        {formatDetails(event).slice(0, detailsWidth)}
      </Text>
    </Box>
  );
}
