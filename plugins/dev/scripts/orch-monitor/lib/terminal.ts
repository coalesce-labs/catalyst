import { subscribe } from "./event-bus";
import type { MonitorSnapshot, WorkerState } from "./state-reader";

// ANSI constants
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const BLUE = "\x1b[34m";
const DIM = "\x1b[2m";
const CLEAR = "\x1b[2J\x1b[H"; // clear screen + cursor home

const STATUS_COLORS: Record<string, string> = {
  done: GREEN,
  in_progress: BLUE,
  implementing: BLUE,
  researching: BLUE,
  failed: RED,
  stalled: YELLOW,
  dispatched: DIM,
};

// Column widths — total <=80 cols with single-space separators
// TICKET(10) STATUS(13) PHASE(5) PID(7) AGE(6) PR(6) -> 47 + 5 spaces = 52
// Extra padding for readability. We budget exactly 80.
const COL = {
  ticket: 12,
  status: 13,
  phase: 5,
  pid: 7,
  age: 6,
  pr: 8,
} as const;
// Widths sum: 12+13+5+7+6+8 = 51, plus 5 spaces = 56. Fits 80 easily.

function pad(s: string, width: number): string {
  if (s.length >= width) return s.slice(0, width);
  return s + " ".repeat(width - s.length);
}

function padLeft(s: string, width: number): string {
  if (s.length >= width) return s.slice(0, width);
  return " ".repeat(width - s.length) + s;
}

function colorize(text: string, color: string | undefined): string {
  if (!color) return text;
  return `${color}${text}${RESET}`;
}

function formatAge(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "-";
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

function renderWorkerRow(w: WorkerState): string {
  const statusColor = STATUS_COLORS[w.status];
  const ticket = pad(w.ticket || "-", COL.ticket);
  const statusRaw = pad(w.status || "-", COL.status);
  const status = colorize(statusRaw, statusColor);
  const phase = padLeft(String(w.phase ?? 0), COL.phase);
  const pidStr = w.pid == null ? "-" : String(w.pid);
  const pid = padLeft(w.alive ? pidStr : `${pidStr}!`, COL.pid);
  const age = padLeft(formatAge(w.timeSinceUpdate), COL.age);
  const pr = pad(w.pr ? `#${w.pr.number}` : "-", COL.pr);
  return `${ticket} ${status} ${phase} ${pid} ${age} ${pr}`;
}

function renderOrchestrator(
  orch: MonitorSnapshot["orchestrators"][number]
): string {
  const lines: string[] = [];
  const header = `${BOLD}${orch.id}${RESET}  Wave ${orch.currentWave}/${orch.totalWaves}`;
  lines.push(header);
  lines.push(DIM + "-".repeat(60) + RESET);

  // Table header (no color)
  const head =
    pad("TICKET", COL.ticket) +
    " " +
    pad("STATUS", COL.status) +
    " " +
    padLeft("PHASE", COL.phase) +
    " " +
    padLeft("PID", COL.pid) +
    " " +
    padLeft("AGE", COL.age) +
    " " +
    pad("PR", COL.pr);
  lines.push(BOLD + head + RESET);

  const workers = Object.values(orch.workers);
  if (workers.length === 0) {
    lines.push(DIM + "(no workers)" + RESET);
  } else {
    // Stable sort by ticket for deterministic output
    workers.sort((a, b) => a.ticket.localeCompare(b.ticket));
    for (const w of workers) {
      lines.push(renderWorkerRow(w));
    }
  }
  return lines.join("\n");
}

/**
 * Pure function: builds an ANSI-formatted dashboard string from a snapshot.
 * Kept <=80 visible columns. Color-codes worker status via STATUS_COLORS.
 */
export function renderSnapshot(snapshot: MonitorSnapshot): string {
  const lines: string[] = [];
  lines.push(
    `${BOLD}Orchestration Monitor${RESET} ${DIM}${snapshot.timestamp}${RESET}`
  );
  lines.push("");

  if (snapshot.orchestrators.length === 0) {
    lines.push(DIM + "No orchestrators found." + RESET);
    return lines.join("\n") + "\n";
  }

  snapshot.orchestrators.forEach((orch, i) => {
    if (i > 0) lines.push("");
    lines.push(renderOrchestrator(orch));
  });
  return lines.join("\n") + "\n";
}

/**
 * Subscribes to `snapshot` events on the event bus and writes a cleared,
 * ANSI-formatted dashboard to stdout for each one. Returns an unsubscribe fn.
 */
export function startTerminalRenderer(): () => void {
  const unsubscribe = subscribe("snapshot", (data: unknown) => {
    const snapshot = data as MonitorSnapshot;
    process.stdout.write(CLEAR + renderSnapshot(snapshot));
  });
  return unsubscribe;
}

// NOTE: Wiring into server.ts (Phase 3 owns that file):
// add a `--terminal` flag that calls `startTerminalRenderer()` alongside the
// HTTP server so phone access and terminal dashboard coexist. Example:
//   if (process.argv.includes("--terminal")) startTerminalRenderer();
