// dashboard-format.ts — pure formatters for the HUD dashboard (CTL-392).

import type { BrokerInterest } from "./broker-interests-reader.ts";

export const STALE_HEARTBEAT_MS = 5 * 60_000;

const EM_DASH = "—";

function parseIsoMs(iso: string | null): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

export function formatRelativeTime(iso: string | null, now: number = Date.now()): string {
  const ms = parseIsoMs(iso);
  if (ms === null) return EM_DASH;
  const delta = Math.max(0, now - ms);
  if (delta < 60_000) return `${Math.floor(delta / 1_000)}s`;
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h`;
  return `${Math.floor(delta / 86_400_000)}d`;
}

export function isStaleHeartbeat(
  iso: string | null,
  thresholdMs: number = STALE_HEARTBEAT_MS,
  now: number = Date.now(),
): boolean {
  const ms = parseIsoMs(iso);
  if (ms === null) return false;
  return now - ms > thresholdMs;
}

export function interestWatches(i: BrokerInterest): string {
  const parts: string[] = [];
  if (i.repo) parts.push(i.repo);
  const prs = i.pr_numbers ?? i.context?.pr_numbers ?? null;
  if (prs && prs.length > 0) parts.push(prs.map((n) => `PR#${n}`).join(", "));
  const tickets = i.tickets ?? i.context?.tickets ?? null;
  if (tickets && tickets.length > 0) parts.push(tickets.join(", "));
  if (parts.length === 0) return EM_DASH;
  return parts.join(" · ");
}

export type WorkerStatusColor = "green" | "red" | "cyan" | "gray" | "yellow";

const IN_PROGRESS_STATUSES = new Set([
  "researching",
  "planning",
  "implementing",
  "validating",
  "shipping",
  "pr-created",
  // phase-agents mode per-phase statuses (CTL-476)
  "dispatched",
  "running",
]);

export function workerStatusColor(status: string): WorkerStatusColor {
  if (status === "done") return "green";
  if (status === "failed" || status === "stalled" || status === "deploy-failed") return "red";
  if (IN_PROGRESS_STATUSES.has(status)) return "cyan";
  return "gray";
}

export function truncateRight(s: string, w: number): string {
  if (w <= 0) return "";
  if (s.length <= w) return s;
  if (w === 1) return "…";
  return s.slice(0, w - 1) + "…";
}

export function lastPathSegment(p: string | null): string {
  if (!p) return EM_DASH;
  const stripped = p.replace(/\/+$/, "");
  if (stripped.length === 0) return EM_DASH;
  const idx = stripped.lastIndexOf("/");
  return idx >= 0 ? stripped.slice(idx + 1) : stripped;
}

// FNV-1a 32-bit hash → base36, padded to 4 chars. Disambiguates workers from
// different orchestrators in the WORKER column without lengthening the cell —
// the full orchestrator ID is still visible in the adjacent ORCHESTRATOR column.
export function shortOrchId(orchestrator: string): string {
  let h = 2166136261;
  for (let i = 0; i < orchestrator.length; i++) {
    h ^= orchestrator.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 1679616).toString(36).padStart(4, "0");
}

// Compress a worker/interest identifier for the HUD WORKER column. Worker names
// follow `{orchestrator}-{ticket}`, so the raw value otherwise looks nearly
// identical to the adjacent ORCHESTRATOR column once truncated. When the raw
// value carries the orchestrator prefix, replace it with a short fingerprint.
export function formatWorkerCell(rawWorker: string, orchestrator: string | null): string {
  if (!orchestrator) return rawWorker;
  const prefix = `${orchestrator}-`;
  if (!rawWorker.startsWith(prefix)) return rawWorker;
  return `${shortOrchId(orchestrator)}:${rawWorker.slice(prefix.length)}`;
}

export const DASHBOARD_VIEWS = ["interests", "workers", "orchs", "runs"] as const;
export type DashboardView = (typeof DASHBOARD_VIEWS)[number];

export function dashboardViewLabel(v: DashboardView): string {
  switch (v) {
    case "interests": return "Interests";
    case "workers": return "Workers";
    case "orchs": return "Orchestrators";
    case "runs": return "Runs";
  }
}
