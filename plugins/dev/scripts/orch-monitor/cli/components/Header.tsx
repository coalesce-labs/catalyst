import { Box, Text } from "ink";

export function Header() {
  return (
    <Box flexDirection="row">
      <Text bold color="white">{"TIME    "}</Text>
      <Text bold color="white">{"REPO        "}</Text>
      <Text bold color="white">{"SOURCE              "}</Text>
      <Text bold color="white">{"EVENT         "}</Text>
      <Text bold color="white">{"REF           "}</Text>
      <Text bold color="white">{"DETAILS"}</Text>
    </Box>
  );
}
