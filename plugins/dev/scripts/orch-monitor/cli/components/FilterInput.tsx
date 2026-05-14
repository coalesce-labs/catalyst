import { Box, Text } from "ink";
import TextInput from "ink-text-input";
import type { PivotMode } from "../hooks/useFilter.ts";

interface FilterInputProps {
  value: string;
  focused: boolean;
  onChange: (v: string) => void;
  pivot: PivotMode;
  cols: number;
  filteredCount: number;
  totalCount: number;
  autoFollow: boolean;
  statusMsg: string | null;
  activeSinceLabel: string | null;
}

// CTL-363: wide-terminal hint set adds h:help / G:newest / r:reset.
// Threshold of 160 cols matches the ticket's example width.
export const WIDE_HINTS_COLS = 160;

export function formatFilterHints(cols: number, focused: boolean): string {
  const focus = focused ? "Esc:clear" : "/:focus";
  // CTL-388: renamed "trace/orch" → "scope-tr/scope-orch" to clarify the verb
  // (you're scoping the view to that ID, not "pivoting" through it). The o/t
  // handlers also gained a pause-first behavior in live mode (see hud.tsx).
  const base = `${focus} | t:scope-tr o:scope-orch | Enter:detail q:quit`;
  if (cols >= WIDE_HINTS_COLS) {
    return `${base} | h:help G:newest r:reset`;
  }
  return base;
}

// CTL-387: footer chip text when a user-interactive `:since` is active.
// Returns null when no active label (chip should not render).
export function formatSinceChipLabel(activeLabel: string | null): string | null {
  if (!activeLabel) return null;
  return `[since: ${activeLabel}]`;
}

export function FilterInput({
  value,
  focused,
  onChange,
  pivot,
  cols,
  filteredCount,
  totalCount,
  autoFollow,
  statusMsg,
  activeSinceLabel,
}: FilterInputProps) {
  const sinceChip = formatSinceChipLabel(activeSinceLabel);
  return (
    <Box flexDirection="row">
      {pivot && (
        <Text color="cyan">{`[${pivot.type}:${pivot.id.slice(0, 12)}…] `}</Text>
      )}
      {sinceChip && (
        <Text color="cyan">{`${sinceChip} `}</Text>
      )}
      <Text dimColor={!focused}>{"/ "}</Text>
      <TextInput value={value} onChange={onChange} focus={focused} placeholder="filter (substring — all fields)" />
      <Box flexGrow={1} marginLeft={2}>
        <Text dimColor wrap="truncate-end">{formatFilterHints(cols, focused)}</Text>
      </Box>
      {statusMsg && <Text color="yellow">{` ${statusMsg} `}</Text>}
      <Text dimColor>{` ${filteredCount}/${totalCount} events`}</Text>
      {autoFollow
        ? <Text color="green">{" [LIVE]"}</Text>
        : <Text dimColor>{" [PAUSED — G to follow]"}</Text>
      }
    </Box>
  );
}
