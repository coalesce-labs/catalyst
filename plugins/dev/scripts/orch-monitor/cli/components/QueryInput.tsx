import { Box, Text } from "ink";
import TextInput from "ink-text-input";

interface QueryInputProps {
  value: string;
  focused: boolean;
  busy: boolean;
  error: string | null;
  hasDsl: boolean;
  onChange: (v: string) => void;
  onSubmit: (v: string) => void;
}

export function QueryInput({ value, focused, busy, error, hasDsl, onChange, onSubmit }: QueryInputProps) {
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
        <Text dimColor>
          {"  "}
          {busy ? "translating…" : focused ? "Enter:run Esc:cancel" : ":focus"}
          {hasDsl ? " | ?:show DSL" : ""}
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
