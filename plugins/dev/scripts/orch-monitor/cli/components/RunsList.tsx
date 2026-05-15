import { Box, Text } from "ink";
import type { RunRow } from "../lib/runs-reader.ts";
import {
  formatRelativeTime,
  truncateRight,
  workerStatusColor,
} from "../lib/dashboard-format.ts";

interface RunsListProps {
  rows: RunRow[];
  selectedIndex: number;
  scrollOffset: number;
  visibleRows: number;
  cols: number;
}

const COL_ORCH = 22;
const COL_TICKET = 10;
const COL_STATUS = 13;
const COL_PHASE = 5;
const COL_PR = 6;
// margins: 5 gaps of 1 between the 6 column groups
const FIXED_COLS = COL_ORCH + COL_TICKET + COL_STATUS + COL_PHASE + COL_PR + 5;

function waveLabel(currentWave: number | null, totalWaves: number | null): string {
  if (currentWave === null && totalWaves === null) return "";
  return `W${currentWave ?? "?"}/${totalWaves ?? "?"}`;
}

export function RunsList({
  rows,
  selectedIndex,
  scrollOffset,
  visibleRows,
  cols,
}: RunsListProps) {
  const titleW = Math.max(4, cols - FIXED_COLS);
  const visible = rows.slice(scrollOffset, scrollOffset + visibleRows);

  const orchCount = rows.filter((r) => r.kind === "orch").length;
  const workerCount = rows.filter((r) => r.kind === "worker").length;

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box flexDirection="row">
        <Box width={COL_ORCH} flexShrink={0} marginRight={1}><Text bold color="cyan">ORCHESTRATOR</Text></Box>
        <Box width={COL_TICKET} flexShrink={0} marginRight={1}><Text bold color="cyan">TICKET</Text></Box>
        <Box width={titleW} flexShrink={0} marginRight={1}><Text bold color="cyan">LABEL</Text></Box>
        <Box width={COL_STATUS} flexShrink={0} marginRight={1}><Text bold color="cyan">STATUS</Text></Box>
        <Box width={COL_PHASE} flexShrink={0} marginRight={1}><Text bold color="cyan">PHASE</Text></Box>
        <Box width={COL_PR} flexShrink={0}><Text bold color="cyan">PR</Text></Box>
      </Box>
      <Text dimColor>{"─".repeat(Math.max(0, cols - 1))}</Text>
      {visible.length === 0 && (
        <Box paddingX={1}><Text dimColor>(no runs found)</Text></Box>
      )}
      {visible.map((row, idx) => {
        const realIdx = scrollOffset + idx;
        const selected = realIdx === selectedIndex;

        if (row.kind === "orch") {
          const wave = waveLabel(row.currentWave, row.totalWaves);
          const active = `${row.workersCount.active}/${row.workersCount.total}`;
          const started = formatRelativeTime(row.startedAt);
          const orchId = truncateRight(row.orchestrator ?? row.orchId, COL_ORCH);
          const summary = truncateRight(
            [wave, `${active} workers`, started ? `ago:${started}` : ""].filter(Boolean).join("  "),
            titleW,
          );
          return (
            <Box key={`orch-${row.orchId}-${realIdx}`} flexDirection="row">
              <Box width={COL_ORCH} flexShrink={0} marginRight={1}>
                <Text color={selected ? "black" : "cyan"} bold={!selected} inverse={selected}>{orchId}</Text>
              </Box>
              <Box width={COL_TICKET} flexShrink={0} marginRight={1}>
                <Text dimColor={!selected} inverse={selected}>{" "}</Text>
              </Box>
              <Box width={titleW} flexShrink={0} marginRight={1}>
                <Text color={selected ? undefined : "cyan"} dimColor={!selected} inverse={selected}>{summary}</Text>
              </Box>
              <Box width={COL_STATUS} flexShrink={0} marginRight={1}>
                <Text dimColor={!selected} inverse={selected}>{" "}</Text>
              </Box>
              <Box width={COL_PHASE} flexShrink={0} marginRight={1}>
                <Text dimColor={!selected} inverse={selected}>{" "}</Text>
              </Box>
              <Box width={COL_PR} flexShrink={0}>
                <Text dimColor={!selected} inverse={selected}>{" "}</Text>
              </Box>
            </Box>
          );
        }

        // Worker row
        const ticket = truncateRight(row.ticket, COL_TICKET);
        const label = truncateRight(row.label ?? "—", titleW);
        const status = truncateRight(row.status, COL_STATUS);
        const phase = truncateRight(row.phase !== null ? String(row.phase) : "—", COL_PHASE);
        const pr = truncateRight(row.pr ? `#${row.pr.number}` : "—", COL_PR);
        const statusColor = workerStatusColor(row.status);

        return (
          <Box key={`worker-${row.orchId}-${row.ticket}-${realIdx}`} flexDirection="row">
            <Box width={COL_ORCH} flexShrink={0} marginRight={1}>
              <Text dimColor={!selected} inverse={selected}>{truncateRight("  └", COL_ORCH)}</Text>
            </Box>
            <Box width={COL_TICKET} flexShrink={0} marginRight={1}>
              <Text color={selected ? "black" : "white"} inverse={selected}>{ticket}</Text>
            </Box>
            <Box width={titleW} flexShrink={0} marginRight={1}>
              <Text dimColor={!selected} inverse={selected}>{label}</Text>
            </Box>
            <Box width={COL_STATUS} flexShrink={0} marginRight={1}>
              <Text color={statusColor} inverse={selected}>{status}</Text>
            </Box>
            <Box width={COL_PHASE} flexShrink={0} marginRight={1}>
              <Text dimColor={!selected} inverse={selected}>{phase}</Text>
            </Box>
            <Box width={COL_PR} flexShrink={0}>
              <Text color={row.pr ? "cyan" : "gray"} inverse={selected}>{pr}</Text>
            </Box>
          </Box>
        );
      })}
      <Box flexGrow={1} />
      <Text dimColor>{`${orchCount} run${orchCount === 1 ? "" : "s"}  ·  ${workerCount} worker${workerCount === 1 ? "" : "s"}  ·  recent window 24h`}</Text>
    </Box>
  );
}
