import { Box, Text } from "ink";
import type { WaitingSession } from "../lib/broker-key-health.ts";
import type { WorkerSignal } from "../lib/worker-signals-reader.ts";
import {
  formatRelativeTime,
  isStaleHeartbeat,
  lastPathSegment,
  truncateRight,
  workerStatusColor,
} from "../lib/dashboard-format.ts";

export type WorkerSortKey = "worker" | "status" | "phase" | "pr" | "heartbeat";

interface WorkerListProps {
  workers: WorkerSignal[];
  selectedIndex: number;
  scrollOffset: number;
  visibleRows: number;
  cols: number;
  waitingSessions?: WaitingSession[];
  sortKey?: WorkerSortKey;
  sortDir?: "asc" | "desc";
}

function findWaitingSession(ticket: string, sessions: WaitingSession[], nowMs: number): WaitingSession | null {
  for (const ws of sessions) {
    if (ws.ticket === ticket && ws.timeoutAt && Date.parse(ws.timeoutAt) > nowMs) {
      return ws;
    }
  }
  return null;
}

function formatTimeoutRemaining(timeoutAt: string, nowMs: number): string {
  const ms = Date.parse(timeoutAt) - nowMs;
  if (ms <= 0) return "0s";
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m`;
  return `${Math.round(mins / 60)}h`;
}

const COL_WORKER = 32;
const COL_STATUS = 13;
const COL_PHASE = 5;
const COL_PR = 6;
const COL_HEARTBEAT = 10;

function sortIndicator(col: WorkerSortKey, sortKey: WorkerSortKey, sortDir: "asc" | "desc"): string {
  return col === sortKey ? (sortDir === "asc" ? " ▲" : " ▼") : "";
}

export function WorkerList({
  workers,
  selectedIndex,
  scrollOffset,
  visibleRows,
  cols,
  waitingSessions = [],
  sortKey = "heartbeat",
  sortDir = "desc",
}: WorkerListProps) {
  const worktreeW = Math.max(8, cols - COL_WORKER - COL_STATUS - COL_PHASE - COL_PR - COL_HEARTBEAT - 6);
  const visible = workers.slice(scrollOffset, scrollOffset + visibleRows);
  const nowMs = Date.now();

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box flexDirection="row">
        <Box width={COL_WORKER} flexShrink={0} marginRight={1}><Text bold color="cyan">{`WORKER${sortIndicator("worker", sortKey, sortDir)}`}</Text></Box>
        <Box width={COL_STATUS} flexShrink={0} marginRight={1}><Text bold color="cyan">{`STATUS${sortIndicator("status", sortKey, sortDir)}`}</Text></Box>
        <Box width={COL_PHASE} flexShrink={0} marginRight={1}><Text bold color="cyan">{`PHASE${sortIndicator("phase", sortKey, sortDir)}`}</Text></Box>
        <Box width={COL_PR} flexShrink={0} marginRight={1}><Text bold color="cyan">{`PR${sortIndicator("pr", sortKey, sortDir)}`}</Text></Box>
        <Box width={COL_HEARTBEAT} flexShrink={0} marginRight={1}><Text bold color="cyan">{`HEARTBEAT${sortIndicator("heartbeat", sortKey, sortDir)}`}</Text></Box>
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
        const ws = findWaitingSession(w.ticket, waitingSessions, nowMs);
        const statusColor = ws ? "magenta" : workerStatusColor(w.status);
        const statusText = ws ? `wait:${formatTimeoutRemaining(ws.timeoutAt, nowMs)}` : w.status;
        const worker = truncateRight(w.workerName, COL_WORKER);
        const status = truncateRight(statusText, COL_STATUS);
        const phase = truncateRight(w.phase !== null ? String(w.phase) : "—", COL_PHASE);
        const pr = truncateRight(w.pr ? `#${w.pr.number}` : "—", COL_PR);
        const heartbeat = truncateRight(formatRelativeTime(w.lastHeartbeat), COL_HEARTBEAT);
        const worktree = truncateRight(lastPathSegment(w.worktreePath), worktreeW);
        return (
          <Box key={`${w.workerName}-${realIdx}`} flexDirection="column">
            <Box flexDirection="row">
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
                <Text color={stale && !ws ? "yellow" : undefined} dimColor={!stale && !selected} inverse={selected}>{heartbeat}</Text>
              </Box>
              <Box flexGrow={1}>
                <Text dimColor={!selected} inverse={selected}>{worktree}</Text>
              </Box>
            </Box>
            {ws && selected && (
              <Box paddingX={1}>
                <Text color="magenta" dimColor>
                  {`  ⏳ waiting for: ${ws.waitFor ? truncateRight(ws.waitFor, cols - 20) : "(unknown)"}`}
                </Text>
              </Box>
            )}
          </Box>
        );
      })}
      <Box flexGrow={1} />
      <Text dimColor>{`${workers.length} worker${workers.length === 1 ? "" : "s"}  ·  recent window 24h  ·  stale = no heartbeat in 5m`}</Text>
    </Box>
  );
}
