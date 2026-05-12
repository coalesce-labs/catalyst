import { Box, Text } from "ink";
import type { BrokerKeyHealth } from "../lib/broker-key-health.ts";
import { chipColor, chipLabel } from "../lib/broker-key-health.ts";

interface HeaderProps {
  columns?: number;
  nlQuery?: string;
  brokerKeyHealth?: BrokerKeyHealth | null;
}

export function Header({ columns = 120, nlQuery, brokerKeyHealth }: HeaderProps) {
  const sep = "─".repeat(Math.max(0, columns - 1));
  const groq = brokerKeyHealth?.groq;
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
        <Text bold color="cyan">{"TIME      "}</Text>
        <Text bold color="cyan">{"REPO        "}</Text>
        <Text bold color="cyan">{"SOURCE              "}</Text>
        <Text bold color="cyan">{"EVENT           "}</Text>
        <Text bold color="cyan">{"REF       "}</Text>
        <Text bold color="cyan">{"DETAILS"}</Text>
      </Box>
      <Text dimColor>{sep}</Text>
      {nlQuery && (
        <Text color="magenta">{`  ⬡ ${nlQuery}`}</Text>
      )}
    </Box>
  );
}
