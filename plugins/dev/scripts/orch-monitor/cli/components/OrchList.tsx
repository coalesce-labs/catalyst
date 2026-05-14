import { Box, Text } from "ink";
import type { OrchState } from "../lib/orch-state-reader.ts";
import { formatRelativeTime, truncateRight } from "../lib/dashboard-format.ts";

interface OrchListProps {
  orchs: OrchState[];
  selectedIndex: number;
  scrollOffset: number;
  visibleRows: number;
  cols: number;
}

const COL_ORCH = 38;
const COL_WAVE = 5;
const COL_ACTIVE = 9;
const COL_QUEUE = 6;
const COL_STARTED = 12;
const COL_PARALLEL = 8;

function waveLabel(o: OrchState): string {
  if (o.currentWave === null && o.totalWaves === null) return "—";
  return `${o.currentWave ?? "?"}/${o.totalWaves ?? "?"}`;
}

export function OrchList({
  orchs,
  selectedIndex,
  scrollOffset,
  visibleRows,
  cols,
}: OrchListProps) {
  const visible = orchs.slice(scrollOffset, scrollOffset + visibleRows);

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box flexDirection="row">
        <Box width={COL_ORCH} flexShrink={0} marginRight={1}><Text bold color="cyan">ORCHESTRATOR</Text></Box>
        <Box width={COL_WAVE} flexShrink={0} marginRight={1}><Text bold color="cyan">WAVE</Text></Box>
        <Box width={COL_ACTIVE} flexShrink={0} marginRight={1}><Text bold color="cyan">ACTIVE</Text></Box>
        <Box width={COL_QUEUE} flexShrink={0} marginRight={1}><Text bold color="cyan">QUEUE</Text></Box>
        <Box width={COL_STARTED} flexShrink={0} marginRight={1}><Text bold color="cyan">STARTED</Text></Box>
        <Box width={COL_PARALLEL} flexShrink={0}><Text bold color="cyan">PARALLEL</Text></Box>
      </Box>
      <Text dimColor>{"─".repeat(Math.max(0, cols - 1))}</Text>
      {visible.length === 0 && (
        <Box paddingX={1}><Text dimColor>(no orchestrators found)</Text></Box>
      )}
      {visible.map((o, idx) => {
        const realIdx = scrollOffset + idx;
        const selected = realIdx === selectedIndex;
        const orch = truncateRight(o.orchestrator ?? o.id, COL_ORCH);
        const wave = truncateRight(waveLabel(o), COL_WAVE);
        const active = truncateRight(`${o.workersCount.active}/${o.workersCount.total}`, COL_ACTIVE);
        const queue = truncateRight(String(o.queueLength), COL_QUEUE);
        const started = truncateRight(formatRelativeTime(o.startedAt), COL_STARTED);
        const parallel = truncateRight(o.maxParallel !== null ? String(o.maxParallel) : "—", COL_PARALLEL);
        return (
          <Box key={`${o.id}-${realIdx}`} flexDirection="row">
            <Box width={COL_ORCH} flexShrink={0} marginRight={1}>
              <Text color={selected ? "black" : "white"} inverse={selected}>{orch}</Text>
            </Box>
            <Box width={COL_WAVE} flexShrink={0} marginRight={1}>
              <Text dimColor={!selected} inverse={selected}>{wave}</Text>
            </Box>
            <Box width={COL_ACTIVE} flexShrink={0} marginRight={1}>
              <Text color={o.workersCount.active > 0 ? "cyan" : undefined} dimColor={!selected && o.workersCount.active === 0} inverse={selected}>{active}</Text>
            </Box>
            <Box width={COL_QUEUE} flexShrink={0} marginRight={1}>
              <Text dimColor={!selected} inverse={selected}>{queue}</Text>
            </Box>
            <Box width={COL_STARTED} flexShrink={0} marginRight={1}>
              <Text dimColor={!selected} inverse={selected}>{started}</Text>
            </Box>
            <Box width={COL_PARALLEL} flexShrink={0}>
              <Text dimColor={!selected} inverse={selected}>{parallel}</Text>
            </Box>
          </Box>
        );
      })}
      <Box flexGrow={1} />
      <Text dimColor>{`${orchs.length} orchestrator${orchs.length === 1 ? "" : "s"}`}</Text>
    </Box>
  );
}
