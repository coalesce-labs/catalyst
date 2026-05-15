import { Box, Text } from "ink";
import type { BrokerInterest } from "../lib/broker-interests-reader.ts";
import type { BrokerState } from "../lib/broker-key-health.ts";
import { formatRelativeTime, interestWatches, truncateRight } from "../lib/dashboard-format.ts";

interface InterestListProps {
  interests: BrokerInterest[];
  selectedIndex: number;
  scrollOffset: number;
  visibleRows: number;
  cols: number;
  brokerState: BrokerState | null;
}

const COL_ORCH = 25;
const COL_TYPE = 16;
const COL_WATCHES = 28;

function interestTypeLabel(t: BrokerInterest["interest_type"]): string {
  return t ?? "prose";
}

function footerSummary(interests: BrokerInterest[], brokerState: BrokerState | null, now: number = Date.now()): string {
  const n = interests.length;
  const lastWake = brokerState?.lastWakeAt ? formatRelativeTime(brokerState.lastWakeAt, now) : "—";
  const lastReg = brokerState?.lastRegisterAt ? formatRelativeTime(brokerState.lastRegisterAt, now) : "—";
  const uptime = brokerState?.startedAt ? formatRelativeTime(brokerState.startedAt, now) : "—";
  return `${n} interest${n === 1 ? "" : "s"}  ·  last wake ${lastWake} ago  ·  last register ${lastReg} ago  ·  daemon up ${uptime}`;
}

export function InterestList({
  interests,
  selectedIndex,
  scrollOffset,
  visibleRows,
  cols,
  brokerState,
}: InterestListProps) {
  const promptW = Math.max(8, cols - COL_ORCH - COL_TYPE - COL_WATCHES - 4);
  const visible = interests.slice(scrollOffset, scrollOffset + visibleRows);
  const hasProse = interests.some((i) => i.interest_type === null);
  // proseEnabled is only false (not undefined) when the broker has explicitly written the field.
  const proseOff = hasProse && brokerState?.proseEnabled === false;

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box flexDirection="row">
        <Box width={COL_ORCH} flexShrink={0} marginRight={1}><Text bold color="cyan">ORCHESTRATOR</Text></Box>
        <Box width={COL_TYPE} flexShrink={0} marginRight={1}><Text bold color="cyan">TYPE</Text></Box>
        <Box width={COL_WATCHES} flexShrink={0} marginRight={1}><Text bold color="cyan">WATCHES</Text></Box>
        <Box flexGrow={1}>
          <Text bold color="cyan">PROMPT</Text>
          {proseOff && <Text color="yellow">  [prose: OFF]</Text>}
        </Box>
      </Box>
      <Text dimColor>{"─".repeat(Math.max(0, cols - 1))}</Text>
      {visible.length === 0 && (
        <Box paddingX={1}><Text dimColor>(no interests registered)</Text></Box>
      )}
      {visible.map((i, idx) => {
        const realIdx = scrollOffset + idx;
        const selected = realIdx === selectedIndex;
        const isInactiveProse = i.interest_type === null && proseOff;
        const orch = truncateRight(i.orchestrator ?? "—", COL_ORCH);
        const type = truncateRight(interestTypeLabel(i.interest_type), COL_TYPE);
        const watches = truncateRight(interestWatches(i), COL_WATCHES);
        const prompt = truncateRight(i.prompt || "(deterministic)", promptW);
        return (
          <Box key={`${i.key}-${realIdx}`} flexDirection="row">
            <Box width={COL_ORCH} flexShrink={0} marginRight={1}>
              <Text dimColor={isInactiveProse && !selected} color={selected ? "black" : "white"} inverse={selected}>{orch}</Text>
            </Box>
            <Box width={COL_TYPE} flexShrink={0} marginRight={1}>
              <Text dimColor={isInactiveProse && !selected} color={i.interest_type ? "green" : "yellow"} inverse={selected}>{type}</Text>
            </Box>
            <Box width={COL_WATCHES} flexShrink={0} marginRight={1}>
              <Text dimColor={isInactiveProse && !selected} color={selected ? "black" : "white"} inverse={selected}>{watches}</Text>
            </Box>
            <Box flexGrow={1}>
              <Text dimColor={!selected} inverse={selected}>{prompt}</Text>
            </Box>
          </Box>
        );
      })}
      <Box flexGrow={1} />
      <Text dimColor>{footerSummary(interests, brokerState)}</Text>
    </Box>
  );
}
