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
  // CTL-384: shows [WRAP] chip when wrap mode is active.
  wrapMode?: 'truncate' | 'wrap';
  // CTL-389: DSL (NLQ) active state for unified chip set.
  dslActive: boolean;
  dslLabel: string;
}

// CTL-363: wide-terminal hint set adds h:help / G:newest / r:reset.
// Threshold of 160 cols matches the ticket's example width.
export const WIDE_HINTS_COLS = 160;

const CHIP_MAX = 20;
const ELLIPSIS = "…";

function truncChip(text: string): string {
  return text.length > CHIP_MAX ? text.slice(0, CHIP_MAX) + ELLIPSIS : text;
}

export type FilterChip = { label: string; color: "cyan" | "yellow" | "magenta" };

// CTL-387: footer chip label for an active :since window.
// Returns null when no active label (chip should not render).
export function formatSinceChipLabel(activeLabel: string | null): string | null {
  if (!activeLabel) return null;
  return `[since: ${activeLabel}]`;
}

// CTL-389: build the unified active-filter chip set shown in the footer.
// Each active filter mechanism contributes a chip; inactive ones are absent.
export function buildActiveChips(opts: {
  activeSinceLabel: string | null;
  filterText: string;
  dslActive: boolean;
  dslLabel: string;
  pivot: PivotMode;
}): FilterChip[] {
  const chips: FilterChip[] = [];
  if (opts.activeSinceLabel) {
    chips.push({ label: `since: ${truncChip(opts.activeSinceLabel)}`, color: "cyan" });
  }
  if (opts.filterText) {
    chips.push({ label: `/${truncChip(opts.filterText)}`, color: "yellow" });
  }
  if (opts.dslActive) {
    chips.push({ label: `NLQ: ${truncChip(opts.dslLabel)}`, color: "magenta" });
  }
  if (opts.pivot) {
    const id = opts.pivot.id;
    const truncId = id.length > 12 ? `${id.slice(0, 12)}${ELLIPSIS}` : id;
    chips.push({ label: `${opts.pivot.type}: ${truncId}`, color: "cyan" });
  }
  return chips;
}

// CTL-389: when all chips are inactive, filteredCount === totalCount so
// the slash format is redundant; collapse to a single number.
export function formatEventCount(filteredCount: number, totalCount: number): string {
  if (filteredCount === totalCount) return `${totalCount} events`;
  return `${filteredCount}/${totalCount} events`;
}

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
  wrapMode = 'truncate',
  dslActive,
  dslLabel,
}: FilterInputProps) {
  const chips = buildActiveChips({ activeSinceLabel, filterText: value, dslActive, dslLabel, pivot });
  const countStr = formatEventCount(filteredCount, totalCount);
  return (
    <Box flexDirection="row">
      <Text dimColor={!focused}>{"/ "}</Text>
      <TextInput value={value} onChange={onChange} focus={focused} placeholder="filter (substring — all fields)" />
      <Box flexGrow={1} marginLeft={2}>
        <Text dimColor wrap="truncate-end">{formatFilterHints(cols, focused)}</Text>
      </Box>
      {statusMsg && <Text color="yellow">{` ${statusMsg} `}</Text>}
      <Text dimColor>{` ${countStr}`}</Text>
      {chips.map((chip, i) => (
        <Text key={i} color={chip.color}>{` [${chip.label}]`}</Text>
      ))}
      {autoFollow
        ? <Text color="green">{" [LIVE]"}</Text>
        : <Text dimColor>{" [PAUSED — G to follow]"}</Text>
      }
      {wrapMode === 'wrap' && <Text color="cyan">{" [WRAP]"}</Text>}
    </Box>
  );
}
