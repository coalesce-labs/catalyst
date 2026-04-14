import { subscribe } from "./event-bus";
import type { MonitorSnapshot, WorkerState } from "./state-reader";
import type { MonitorEventEnvelope } from "./events";

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

export interface RenderOptions {
  compact?: boolean;
}

const COL_STANDARD = {
  ticket: 10,
  label: 14,
  status: 13,
  phase: 5,
  pid: 7,
  age: 6,
  pr: 8,
} as const;

const COL_COMPACT = {
  ticket: 10,
  status: 8,
  phase: 5,
  age: 6,
  pr: 6,
} as const;

const STATUS_ABBREV: Record<string, string> = {
  implementing: "impl",
  researching: "rsrch",
  in_progress: "in_prog",
  dispatched: "disp",
  validating: "valid",
  shipping: "ship",
  "pr-created": "pr-crtd",
  remediation: "remed",
};

type ColWidths = typeof COL_STANDARD | typeof COL_COMPACT;

function getCols(opts?: RenderOptions): ColWidths {
  return opts?.compact ? COL_COMPACT : COL_STANDARD;
}

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

function renderWorkerRow(w: WorkerState, opts?: RenderOptions): string {
  const col = getCols(opts);
  const statusColor = STATUS_COLORS[w.status];
  const ticket = pad(w.ticket || "-", col.ticket);
  const statusText = opts?.compact
    ? (STATUS_ABBREV[w.status] ?? w.status ?? "-")
    : (w.status || "-");
  const statusRaw = pad(statusText, col.status);
  const status = colorize(statusRaw, statusColor);
  const phase = padLeft(String(w.phase ?? 0), col.phase);
  const age = padLeft(formatAge(w.timeSinceUpdate), col.age);
  const pr = pad(w.pr ? `#${w.pr.number}` : "-", col.pr);

  if (opts?.compact) {
    return `${ticket} ${status} ${phase} ${age} ${pr}`;
  }
  const stdCol = col as typeof COL_STANDARD;
  const label = pad(w.label || "-", stdCol.label);
  const pidStr = w.pid == null ? "-" : String(w.pid);
  const pid = padLeft(w.alive ? pidStr : `${pidStr}!`, stdCol.pid);
  return `${ticket} ${label} ${status} ${phase} ${pid} ${age} ${pr}`;
}

function renderOrchestrator(
  orch: MonitorSnapshot["orchestrators"][number],
  opts?: RenderOptions,
): string {
  const col = getCols(opts);
  const lines: string[] = [];
  const sepWidth = opts?.compact ? 40 : 60;
  const header = `${BOLD}${orch.id}${RESET}  Wave ${orch.currentWave}/${orch.totalWaves}`;
  lines.push(header);
  lines.push(DIM + "-".repeat(sepWidth) + RESET);

  const headParts = [pad("TICKET", col.ticket)];
  if (!opts?.compact) {
    const stdCol = col as typeof COL_STANDARD;
    headParts.push(pad("LABEL", stdCol.label));
  }
  headParts.push(pad("STATUS", col.status));
  headParts.push(padLeft("PHASE", col.phase));
  if (!opts?.compact) {
    headParts.push(padLeft("PID", (col as typeof COL_STANDARD).pid));
  }
  headParts.push(padLeft("AGE", col.age));
  headParts.push(pad("PR", col.pr));
  lines.push(BOLD + headParts.join(" ") + RESET);

  const workers = Object.values(orch.workers);
  if (workers.length === 0) {
    lines.push(DIM + "(no workers)" + RESET);
  } else {
    workers.sort((a, b) => a.ticket.localeCompare(b.ticket));
    for (const w of workers) {
      lines.push(renderWorkerRow(w, opts));
    }
  }
  return lines.join("\n");
}

function costColor(usd: number): string {
  if (!Number.isFinite(usd)) return DIM;
  if (usd < 1) return GREEN;
  if (usd < 5) return YELLOW;
  return RED;
}

export function renderStatsHeader(snapshot: MonitorSnapshot): string {
  const allWorkers: WorkerState[] = [];
  for (const orch of snapshot.orchestrators) {
    allWorkers.push(...Object.values(orch.workers));
  }
  if (allWorkers.length === 0) return "";

  const parts: string[] = [];
  parts.push(`${allWorkers.length} workers`);

  const totalCost = allWorkers.reduce(
    (sum, w) => sum + (w.cost?.costUSD ?? 0),
    0,
  );
  if (totalCost > 0) {
    const costStr = `$${totalCost.toFixed(2)}`;
    parts.push(colorize(costStr, costColor(totalCost)));
  }

  let earliest = Infinity;
  for (const w of allWorkers) {
    if (w.startedAt) {
      const t = Date.parse(w.startedAt);
      if (!Number.isNaN(t) && t < earliest) earliest = t;
    }
  }
  if (Number.isFinite(earliest)) {
    const elapsedSec = Math.max(0, (Date.now() - earliest) / 1000);
    parts.push(formatAge(elapsedSec));
  }

  return `${DIM}${parts.join("  |  ")}${RESET}`;
}

export function renderSnapshot(
  snapshot: MonitorSnapshot,
  opts?: RenderOptions,
): string {
  const lines: string[] = [];
  lines.push(
    `${BOLD}Orchestration Monitor${RESET} ${DIM}${snapshot.timestamp}${RESET}`,
  );

  const stats = renderStatsHeader(snapshot);
  if (stats) lines.push(stats);
  lines.push("");

  if (snapshot.orchestrators.length === 0) {
    lines.push(DIM + "No orchestrators found." + RESET);
    return lines.join("\n") + "\n";
  }

  snapshot.orchestrators.forEach((orch, i) => {
    if (i > 0) lines.push("");
    lines.push(renderOrchestrator(orch, opts));
  });
  return lines.join("\n") + "\n";
}

export function startTerminalRenderer(opts?: RenderOptions): () => void {
  let writeFailed = false;
  const unsubscribe = subscribe("snapshot", (data: unknown) => {
    if (writeFailed) return;
    const envelope = data as MonitorEventEnvelope<MonitorSnapshot>;
    try {
      process.stdout.write(CLEAR + renderSnapshot(envelope.data, opts));
    } catch (err) {
      writeFailed = true;
      console.error("[terminal] stdout write failed, disabling renderer:", err);
    }
  });
  return unsubscribe;
}
