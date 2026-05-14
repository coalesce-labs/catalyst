import { Box, Text } from "ink";
import type { WorkerSignal } from "../lib/worker-signals-reader.ts";
import {
  formatRelativeTime,
  isStaleHeartbeat,
  lastPathSegment,
  truncateRight,
  workerStatusColor,
} from "../lib/dashboard-format.ts";

interface WorkerListProps {
  workers: WorkerSignal[];
  selectedIndex: number;
  scrollOffset: number;
  visibleRows: number;
  cols: number;
}

const COL_WORKER = 32;
const COL_STATUS = 13;
const COL_PHASE = 5;
const COL_PR = 6;
const COL_HEARTBEAT = 10;

export function WorkerList({
  workers,
  selectedIndex,
  scrollOffset,
  visibleRows,
  cols,
}: WorkerListProps) {
  const worktreeW = Math.max(8, cols - COL_WORKER - COL_STATUS - COL_PHASE - COL_PR - COL_HEARTBEAT - 6);
  const visible = workers.slice(scrollOffset, scrollOffset + visibleRows);

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box flexDirection="row">
        <Box width={COL_WORKER} flexShrink={0} marginRight={1}><Text bold color="cyan">WORKER</Text></Box>
        <Box width={COL_STATUS} flexShrink={0} marginRight={1}><Text bold color="cyan">STATUS</Text></Box>
        <Box width={COL_PHASE} flexShrink={0} marginRight={1}><Text bold color="cyan">PHASE</Text></Box>
        <Box width={COL_PR} flexShrink={0} marginRight={1}><Text bold color="cyan">PR</Text></Box>
        <Box width={COL_HEARTBEAT} flexShrink={0} marginRight={1}><Text bold color="cyan">HEARTBEAT</Text></Box>
        <Box flexGrow={1}><Text bold color="cyan">WORKTREE</Text></Box>
      </Box>
      <Text dimColor>{"─".repeat(Math.max(0, cols - 1))}</Text>
      {visible.length === 0 && (
        <Box paddingX={1}><Text dimColor>(no workers found)</Text></Box>
      )}
      {visible.map((w, idx) => {
        const realIdx = scrollOffset + idx;
        const selected = realIdx === selectedIndex;
        const stale = isStaleHeartbeat(w.lastHeartbeat);
        const statusColor = workerStatusColor(w.status);
        const worker = truncateRight(w.workerName, COL_WORKER);
        const status = truncateRight(w.status, COL_STATUS);
        const phase = truncateRight(w.phase !== null ? String(w.phase) : "—", COL_PHASE);
        const pr = truncateRight(w.pr ? `#${w.pr.number}` : "—", COL_PR);
        const heartbeat = truncateRight(formatRelativeTime(w.lastHeartbeat), COL_HEARTBEAT);
        const worktree = truncateRight(lastPathSegment(w.worktreePath), worktreeW);
        return (
          <Box key={`${w.workerName}-${realIdx}`} flexDirection="row">
            <Box width={COL_WORKER} flexShrink={0} marginRight={1}>
              <Text color={selected ? "black" : "white"} inverse={selected}>{worker}</Text>
            </Box>
            <Box width={COL_STATUS} flexShrink={0} marginRight={1}>
              <Text color={statusColor} inverse={selected}>{status}</Text>
            </Box>
            <Box width={COL_PHASE} flexShrink={0} marginRight={1}>
              <Text dimColor={!selected} inverse={selected}>{phase}</Text>
            </Box>
            <Box width={COL_PR} flexShrink={0} marginRight={1}>
              <Text color={w.pr ? "cyan" : "gray"} inverse={selected}>{pr}</Text>
            </Box>
            <Box width={COL_HEARTBEAT} flexShrink={0} marginRight={1}>
              <Text color={stale ? "yellow" : undefined} dimColor={!stale && !selected} inverse={selected}>{heartbeat}</Text>
            </Box>
            <Box flexGrow={1}>
              <Text dimColor={!selected} inverse={selected}>{worktree}</Text>
            </Box>
          </Box>
        );
      })}
      <Box flexGrow={1} />
      <Text dimColor>{`${workers.length} worker${workers.length === 1 ? "" : "s"}  ·  recent window 24h  ·  stale = no heartbeat in 5m`}</Text>
    </Box>
  );
}
