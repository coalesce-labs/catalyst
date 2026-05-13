import { Box, Text } from "ink";
import type { BrokerKeyHealth } from "../lib/broker-key-health.ts";
import { chipColor, chipLabel } from "../lib/broker-key-health.ts";
import { computeColumnWidths } from "../lib/column-widths.ts";

interface HeaderProps {
  columns?: number;
  nlQuery?: string;
  brokerKeyHealth?: BrokerKeyHealth | null;
}

// CTL-351: match EventRow's per-column 1-col right margin so the header
// labels align with the row content below them at every terminal width.
export function Header({ columns = 120, nlQuery, brokerKeyHealth }: HeaderProps) {
  const sep = "─".repeat(Math.max(0, columns - 1));
  const groq = brokerKeyHealth?.groq;
  const w = computeColumnWidths(columns);
  return (
    <Box flexDirection="column">
      {groq && (
        <Box flexDirection="row">
          <Text color={chipColor(groq.probeStatus)}>{`[Groq: ${chipLabel(groq.probeStatus)}]`}</Text>
          {groq.present && groq.prefix && (
            <Text dimColor>{`  ${groq.prefix}... (${groq.source ?? "unknown"})`}</Text>
          )}
        </Box>
      )}
      <Box flexDirection="row">
        {w.showStatus && (
          <Box width={w.status} flexShrink={0} marginRight={1}>
            <Text bold color="cyan">{"S"}</Text>
          </Box>
        )}
        <Box width={w.time} flexShrink={0} marginRight={1}>
          <Text bold color="cyan">{"TIME"}</Text>
        </Box>
        <Box width={w.repo} flexShrink={0} marginRight={1}>
          <Text bold color="cyan">{"REPO"}</Text>
        </Box>
        <Box width={w.source} flexShrink={0} marginRight={1}>
          <Text bold color="cyan">{"SOURCE"}</Text>
        </Box>
        <Box width={w.event} flexShrink={0} marginRight={1}>
          <Text bold color="cyan">{"EVENT"}</Text>
        </Box>
        <Box width={w.ref} flexShrink={0} marginRight={1}>
          <Text bold color="cyan">{"REF"}</Text>
        </Box>
        {w.showOrch && (
          <Box width={w.orch} flexShrink={0} marginRight={1}>
            <Text bold color="cyan">{"ORCH"}</Text>
          </Box>
        )}
        {w.showWorker && (
          <Box width={w.worker} flexShrink={0} marginRight={1}>
            <Text bold color="cyan">{"WORKER"}</Text>
          </Box>
        )}
        {w.showEventId && (
          <Box width={w.eventId} flexShrink={0} marginRight={1}>
            <Text bold color="cyan">{"EVENT-ID"}</Text>
          </Box>
        )}
        <Box flexGrow={1}>
          <Text bold color="cyan">{"DETAILS"}</Text>
        </Box>
      </Box>
      <Text dimColor>{sep}</Text>
      {nlQuery && (
        <Text color="magenta">{`  ⬡ ${nlQuery}`}</Text>
      )}
    </Box>
  );
}
