import { Box, Text } from "ink";
import type { BrokerState } from "../lib/broker-key-health.ts";
import {
  chipColor,
  chipLabel,
  brokerInterestStatus,
  interestChipColor,
  interestChipLabel,
} from "../lib/broker-key-health.ts";
import { computeColumnWidths } from "../lib/column-widths.ts";

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
}

// CTL-351: match EventRow's per-column 1-col right margin so the header
// labels align with the row content below them at every terminal width.
// CTL-352: brokerState replaces brokerKeyHealth — same shape plus liveness
// fields for the new interests pill. The chip row renders whenever either
// Groq or interest data is available.
// CTL-390: the row also renders when a version chip is provided, so users
// always see which catalyst-dev build their HUD is on.
export function Header({ columns = 120, nlQuery, brokerState, version }: HeaderProps) {
  const sep = "─".repeat(Math.max(0, columns - 1));
  const groq = brokerState?.groq;
  const interestStatus = brokerInterestStatus(brokerState ?? null);
  const showInterestChip = interestStatus !== "unknown";
  const showVersionChip = version !== undefined;
  const w = computeColumnWidths(columns);
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
        {/*
          CTL-391: ICON column header is intentionally blank. The icons
          themselves convey their meaning and a single-char header label
          would clutter the row without adding information.
        */}
        <Box width={w.icon} flexShrink={0} marginRight={1}>
          <Text bold color="cyan">{" "}</Text>
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
        <Box width={w.details} flexShrink={0}>
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
