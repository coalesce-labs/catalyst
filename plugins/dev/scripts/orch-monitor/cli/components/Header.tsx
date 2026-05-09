import { Box, Text } from "ink";

interface HeaderProps {
  columns?: number;
  nlQuery?: string;
}

export function Header({ columns = 120, nlQuery }: HeaderProps) {
  const sep = "─".repeat(Math.max(0, columns - 1));
  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Text bold color="cyan">{"TIME      "}</Text>
        <Text bold color="cyan">{"REPO        "}</Text>
        <Text bold color="cyan">{"SOURCE              "}</Text>
        <Text bold color="cyan">{"EVENT               "}</Text>
        <Text bold color="cyan">{"REF           "}</Text>
        <Text bold color="cyan">{"DETAILS"}</Text>
      </Box>
      <Text dimColor>{sep}</Text>
      {nlQuery && (
        <Text color="magenta">{`  ⬡ ${nlQuery}`}</Text>
      )}
    </Box>
  );
}
