import { Box, Text } from "ink";
import type { BrokerState } from "../lib/broker-key-health.ts";
import {
  chipColor,
  chipLabel,
  brokerInterestStatus,
  interestChipColor,
  interestChipLabel,
} from "../lib/broker-key-health.ts";
import { resolveColumns } from "../lib/column-widths.ts";
import type { HudColumnConfig } from "../../lib/monitor-config.ts";

interface HeaderProps {
  columns?: number;
  nlQuery?: string;
  brokerState?: BrokerState | null;
  /**
   * CTL-390: optional plugin-version chip shown at the right of the chip row.
   * `display` is the short label (e.g. "v9.2.0" or "v9.2.0 · local:523b6fe");
   * `isLocal` switches the chip to a yellow accent so hot-patched / worktree
   * source is visually distinct from a clean release.
   */
  version?: { display: string; isLocal: boolean };
  // CTL-394: optional user column config from ~/.config/catalyst/monitor.json.
  columnConfig?: HudColumnConfig[] | null;
}

// CTL-351: match EventRow's per-column 1-col right margin so the header
// labels align with the row content below them at every terminal width.
// CTL-352: brokerState replaces brokerKeyHealth — same shape plus liveness
// fields for the new interests pill.
// CTL-390: the row also renders when a version chip is provided.
// CTL-394: column headers are now data-driven via resolveColumns() so
// custom column configs are automatically reflected in the header row.
export function Header({ columns = 120, nlQuery, brokerState, version, columnConfig }: HeaderProps) {
  const sep = "─".repeat(Math.max(0, columns - 1));
  const groq = brokerState?.groq;
  const interestStatus = brokerInterestStatus(brokerState ?? null);
  const showInterestChip = interestStatus !== "unknown";
  const showVersionChip = version !== undefined;
  const resolved = resolveColumns(columns, columnConfig);
  return (
    <Box flexDirection="column">
      {(groq || showInterestChip || showVersionChip) && (
        <Box flexDirection="row">
          {groq && (
            <Text color={chipColor(groq.probeStatus)}>{`[Groq: ${chipLabel(groq.probeStatus)}]`}</Text>
          )}
          {groq && groq.present && groq.prefix && (
            <Text dimColor>{`  ${groq.prefix}... (${groq.source ?? "unknown"})`}</Text>
          )}
          {showInterestChip && (
            <Text
              color={interestChipColor(interestStatus)}
              inverse={interestStatus === "degraded"}
            >
              {`${groq ? "  " : ""}[broker: ${interestChipLabel(brokerState ?? null, interestStatus)}]`}
            </Text>
          )}
          {showVersionChip && (
            <Text color={version.isLocal ? "yellow" : "gray"}>
              {`${(groq || showInterestChip) ? "  " : ""}[${version.display}]`}
            </Text>
          )}
        </Box>
      )}
      <Box flexDirection="row">
        {resolved.map((col) => {
          const isDetails = col.id === "details";
          return (
            <Box key={col.id} width={col.width} flexShrink={0} marginRight={isDetails ? 0 : 1}>
              <Text bold color="cyan">{col.header}</Text>
            </Box>
          );
        })}
      </Box>
      <Text dimColor>{sep}</Text>
      {nlQuery && (
        <Text color="magenta">{`  ⬡ ${nlQuery}`}</Text>
      )}
    </Box>
  );
}
