import { Box, Text, useStdout } from "ink";
import type { CanonicalEvent } from "../../lib/canonical-event.ts";

interface DetailPaneProps {
  event: CanonicalEvent;
}

export function DetailPane({ event }: DetailPaneProps) {
  const { stdout } = useStdout();
  const maxLines = Math.min(20, Math.floor(((stdout?.rows ?? 40) / 3)));
  const json = JSON.stringify(event, null, 2);
  const lines = json.split("\n").slice(0, maxLines);

  return (
    <Box flexDirection="column">
      <Text bold color="white">{"  Event Detail (Esc to close)"}</Text>
      {lines.map((line, i) => (
        <Text key={i} dimColor>
          {line}
        </Text>
      ))}
    </Box>
  );
}
