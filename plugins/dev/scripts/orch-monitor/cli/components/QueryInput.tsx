import { Box, Text } from "ink";
import TextInput from "ink-text-input";
import { WIDE_HINTS_COLS } from "./FilterInput.tsx";

interface QueryInputProps {
  value: string;
  focused: boolean;
  busy: boolean;
  error: string | null;
  hasDsl: boolean;
  cols: number;
  onChange: (v: string) => void;
  onSubmit: (v: string) => void;
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

export function QueryInput({ value, focused, busy, error, hasDsl, cols, onChange, onSubmit }: QueryInputProps) {
  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Text dimColor={!focused} color={focused ? "magenta" : undefined}>{": "}</Text>
        <TextInput
          value={value}
          onChange={onChange}
          onSubmit={onSubmit}
          focus={focused && !busy}
          placeholder='natural-language query (e.g. "errors today")'
        />
        <Text dimColor wrap="truncate-end">
          {"  "}
          {formatQueryHints(cols, focused, busy, hasDsl)}
        </Text>
      </Box>
      {error !== null && (
        <Box>
          <Text color="red">{`  query error: ${error}`}</Text>
        </Box>
      )}
    </Box>
  );
}
