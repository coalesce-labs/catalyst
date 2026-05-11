import { Box, Text } from "ink";
import TextInput from "ink-text-input";
import type { PivotMode } from "../hooks/useFilter.ts";

interface FilterInputProps {
  value: string;
  focused: boolean;
  onChange: (v: string) => void;
  pivot: PivotMode;
}

export function FilterInput({ value, focused, onChange, pivot }: FilterInputProps) {
  return (
    <Box flexDirection="row">
      {pivot && (
        <Text color="cyan">{`[${pivot.type}:${pivot.id.slice(0, 12)}…] `}</Text>
      )}
      <Text dimColor={!focused}>{"/ "}</Text>
      <TextInput value={value} onChange={onChange} focus={focused} placeholder="filter (substring or .jq)" />
      <Text dimColor wrap="truncate-end">
        {"  "}
        {focused ? "Esc:clear" : "/:focus"}
        {" | t:trace o:orch | Enter:detail q:quit"}
      </Text>
    </Box>
  );
}
