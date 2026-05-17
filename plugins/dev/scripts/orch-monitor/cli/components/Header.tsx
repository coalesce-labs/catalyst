import { memo } from "react";
import { Box, Text } from "ink";
import type { BrokerState } from "../lib/broker-key-health.ts";
import { brokerInterestStatus } from "../lib/broker-key-health.ts";
import { resolveColumns } from "../lib/column-widths.ts";
import type { HudColumnConfig } from "../../lib/monitor-config.ts";
import { layoutHeaderChips } from "./header-chips.ts";

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
// CTL-434: chip layout is computed by layoutHeaderChips() which keeps the
// row on a single line by abbreviating labels rather than wrapping.
// CTL-473: memo wrap. With Phase 1's stabilized `version` prop, this short-
// circuits on every render where only unrelated state changed. brokerState
// still defeats the memo every 5s (by design — that's the poll cadence).
function HeaderImpl({ columns = 120, nlQuery, brokerState, version, columnConfig }: HeaderProps) {
  const sep = "─".repeat(Math.max(0, columns - 1));
  const groq = brokerState?.groq;
  const interestStatus = brokerInterestStatus(brokerState ?? null);
  const chips = layoutHeaderChips({
    columns,
    groqStatus: groq ? groq.probeStatus : null,
    groqPresent: groq?.present ?? false,
    groqPrefix: groq?.prefix ?? null,
    groqSource: groq?.source ?? null,
    interestStatus,
    interestCount: brokerState?.interestCount ?? null,
    versionDisplay: version?.display ?? null,
    versionIsLocal: version?.isLocal ?? false,
  });
  const resolved = resolveColumns(columns, columnConfig);
  return (
    <Box flexDirection="column">
      {chips.segments.length > 0 && (
        <Box flexDirection="row">
          {chips.segments.map((s, i) => (
            <Text key={i} color={s.color} inverse={s.inverse} dimColor={s.dim}>
              {s.text}
            </Text>
          ))}
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

export const Header = memo(HeaderImpl);
Header.displayName = "Header";
