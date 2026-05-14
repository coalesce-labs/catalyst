import { useRef, useState } from "react";
import { Box, Text, useInput, type Key } from "ink";
import type { PivotMode } from "../hooks/useFilter.ts";

export const WIDE_HINTS_COLS = 160;
export type InputMode = "normal" | "filter" | "query";

const CHIP_MAX = 20;
const ELLIPSIS = "…";

function truncChip(text: string): string {
  return text.length > CHIP_MAX ? text.slice(0, CHIP_MAX) + ELLIPSIS : text;
}

export type FilterChip = { label: string; color: "cyan" | "yellow" | "magenta" };

// CTL-389: build the unified active-filter chip set shown in the footer.
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

// CTL-389: collapse N/M when all events are visible.
export function formatEventCount(filteredCount: number, totalCount: number): string {
  if (filteredCount === totalCount) return `${totalCount} events`;
  return `${filteredCount}/${totalCount} events`;
}

export function formatFilterHints(cols: number, focused: boolean): string {
  const focus = focused ? "Esc:clear" : "/:focus";
  // CTL-388: renamed "trace/orch" → "scope-tr/scope-orch" to clarify the verb
  const base = `${focus} | t:scope-tr o:scope-orch | Enter:detail q:quit`;
  if (cols >= WIDE_HINTS_COLS) {
    return `${base} | h:help G:newest r:reset`;
  }
  return base;
}

export function formatQueryHints(
  cols: number,
  focused: boolean,
  busy: boolean,
  hasDsl: boolean,
): string {
  const core = busy
    ? "translating…"
    : focused
      ? "Enter:run Esc:cancel"
      : ":focus";
  let out = core;
  if (hasDsl) out += " | ?:show DSL";
  if (cols >= WIDE_HINTS_COLS && !focused && !busy) out += " | h:help";
  return out;
}

interface PromptInputProps {
  mode: InputMode;
  value: string;
  onChange: (v: string) => void;
  onSubmit: (v: string) => void;
  onModeChange: (mode: InputMode) => void;
  onEsc?: () => void;
  busy: boolean;
  error: string | null;
  pivot: PivotMode;
  cols: number;
  filteredCount: number;
  totalCount: number;
  autoFollow: boolean;
  statusMsg: string | null;
  hasDsl: boolean;
  // CTL-389: active filter chips
  activeSinceLabel: string | null;
  dslActive: boolean;
  dslLabel: string;
  // CTL-384: wrap mode chip
  wrapMode?: 'truncate' | 'wrap';
}

export function PromptInput({
  mode,
  value,
  onChange,
  onSubmit,
  onModeChange,
  onEsc,
  busy,
  error,
  pivot,
  cols,
  filteredCount,
  totalCount,
  autoFollow,
  statusMsg,
  hasDsl,
  activeSinceLabel,
  dslActive,
  dslLabel,
  wrapMode = 'truncate',
}: PromptInputProps) {
  const [cursorPos, setCursorPos] = useState(0);
  const filterHistory = useRef<string[]>([]);
  const queryHistory = useRef<string[]>([]);
  const [histCursor, setHistCursor] = useState(-1);

  const focused = mode !== "normal";

  useInput(
    (input: string, key: Key) => {
      if (key.escape) {
        onChange("");
        setCursorPos(0);
        setHistCursor(-1);
        onModeChange("normal");
        onEsc?.();
        return;
      }

      if (key.return && !busy) {
        const v = value.trim();
        if (v) {
          const hist = mode === "filter" ? filterHistory.current : queryHistory.current;
          if (hist[hist.length - 1] !== v) {
            if (hist.length >= 20) hist.shift();
            hist.push(v);
          }
        }
        setHistCursor(-1);
        onSubmit(value);
        return;
      }

      if (key.upArrow) {
        const hist = mode === "filter" ? filterHistory.current : queryHistory.current;
        const next = histCursor + 1;
        if (next < hist.length) {
          const v = hist[hist.length - 1 - next] ?? "";
          setHistCursor(next);
          onChange(v);
          setCursorPos(v.length);
        }
        return;
      }

      if (key.downArrow) {
        const hist = mode === "filter" ? filterHistory.current : queryHistory.current;
        if (histCursor > 0) {
          const next = histCursor - 1;
          const v = hist[hist.length - 1 - next] ?? "";
          setHistCursor(next);
          onChange(v);
          setCursorPos(v.length);
        } else if (histCursor === 0) {
          setHistCursor(-1);
          onChange("");
          setCursorPos(0);
        }
        return;
      }

      if (key.leftArrow) {
        setCursorPos((p: number) => Math.max(0, p - 1));
        return;
      }

      if (key.rightArrow) {
        setCursorPos((p: number) => Math.min(value.length, p + 1));
        return;
      }

      if (key.backspace || key.delete) {
        if (cursorPos > 0) {
          const newValue = value.slice(0, cursorPos - 1) + value.slice(cursorPos);
          onChange(newValue);
          setCursorPos((p: number) => p - 1);
        }
        return;
      }

      if (input && !key.ctrl && !key.meta) {
        const newValue = value.slice(0, cursorPos) + input + value.slice(cursorPos);
        onChange(newValue);
        setCursorPos((p: number) => p + input.length);
        setHistCursor(-1);
      }
    },
    { isActive: focused },
  );

  // Clamp cursor to value length (handles external value resets without useEffect).
  const safeCursor = Math.min(cursorPos, value.length);
  const before = value.slice(0, safeCursor);
  const atCursor = value[safeCursor] ?? " ";
  const after = value.slice(safeCursor + 1);

  const hints =
    mode === "filter"
      ? formatFilterHints(cols, true)
      : mode === "query"
        ? formatQueryHints(cols, true, busy, hasDsl)
        : formatFilterHints(cols, false);

  const chips = buildActiveChips({
    activeSinceLabel,
    filterText: mode !== "normal" ? value : "",
    dslActive,
    dslLabel,
    pivot,
  });
  const countStr = formatEventCount(filteredCount, totalCount);

  return (
    <Box borderStyle="round" borderColor={focused ? "cyan" : "gray"} paddingX={1} flexDirection="row">
      {mode === "filter" && <Text color="yellow">{">"}</Text>}
      {mode === "query" && <Text color="yellow">{"~"}</Text>}
      {focused && <Text>{" "}</Text>}
      {focused ? (
        <>
          <Text>{before}</Text>
          <Text inverse>{atCursor}</Text>
          <Text>{after}</Text>
        </>
      ) : (
        <Text dimColor>{statusMsg ?? "press / to filter, : to query"}</Text>
      )}
      <Box flexGrow={1} marginLeft={2}>
        {error !== null ? (
          <Text color="red" wrap="truncate-end">{error}</Text>
        ) : (
          <Text dimColor wrap="truncate-end">{hints}</Text>
        )}
      </Box>
      {focused && statusMsg !== null && error === null && (
        <Text color="yellow">{` ${statusMsg} `}</Text>
      )}
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
