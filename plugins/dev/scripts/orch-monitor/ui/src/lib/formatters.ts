export function fmtSince(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m " + (s % 60) + "s";
  const h = Math.floor(m / 60);
  return h + "h " + (m % 60) + "m";
}

export function fmtDuration(ms: number): string {
  if (!ms || ms < 0) return "";
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m " + (s % 60) + "s";
  const h = Math.floor(m / 60);
  return h + "h " + (m % 60) + "m";
}

export function fmtTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "—";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 10_000) return Math.round(n / 1000) + "k";
  if (n >= 1_000) return (n / 1000).toFixed(1) + "k";
  return String(Math.round(n));
}

export function fmtClock(d: Date): string {
  return (
    String(d.getHours()).padStart(2, "0") +
    ":" +
    String(d.getMinutes()).padStart(2, "0")
  );
}

export function fmtCost(n: number): string {
  if (!n || n <= 0) return "—";
  return "$" + n.toFixed(2);
}

export function statusClass(s: string): string {
  return (s || "").replace(/[^a-z0-9_]/gi, "_");
}

export type StatusSemantic = "success" | "info" | "danger" | "warning" | "neutral";

const STATUS_SEMANTIC: Record<string, StatusSemantic> = {
  done: "success",
  merged: "success",
  complete: "success",
  in_progress: "info",
  running: "info",
  implementing: "info",
  active: "info",
  provisioning: "info",
  shipping: "info",
  "pr-open": "info",
  dispatched: "neutral",
  pending: "neutral",
  unknown: "neutral",
  signal_corrupt: "danger",
  failed: "danger",
  error: "danger",
  stalled: "warning",
  blocked: "warning",
};

export function statusSemantic(status: string): StatusSemantic {
  return STATUS_SEMANTIC[status] || "neutral";
}

export const SEMANTIC_BADGE_CLASSES: Record<StatusSemantic, string> = {
  success: "bg-green/18 text-green",
  info: "bg-blue/18 text-blue",
  danger: "bg-red/18 text-red",
  warning: "bg-yellow/18 text-yellow",
  neutral: "bg-surface-3 text-muted",
};

export const SEMANTIC_PILL_CLASSES: Record<StatusSemantic, string> = {
  success: "bg-[#1a4a3a] text-[#8af4cc]",
  info: "bg-[#1f3a5a] text-[#9ec7f4]",
  danger: "bg-[#5a2a2a] text-[#f4a8a8]",
  warning: "bg-[#5a4a1a] text-[#f4dc8a]",
  neutral: "bg-surface-3 text-fg border border-border",
};

export const PHASE_COLORS: Record<string, string> = {
  dispatched: "#475569",
  researching: "#3b82f6",
  planning: "#a855f7",
  implementing: "#10b981",
  in_progress: "#10b981",
  validating: "#f59e0b",
  shipping: "#14b8a6",
  "pr-open": "#14b8a6",
  pr_open: "#14b8a6",
  merging: "#6b7280",
  merged: "#6b7280",
  done: "#6b7280",
  failed: "#ef4444",
  stalled: "#eab308",
};

const FALLBACK_PHASE_COLOR = "#3b82f6";

export function phaseColor(phase: string | undefined): string {
  if (!phase) return FALLBACK_PHASE_COLOR;
  return PHASE_COLORS[phase] || FALLBACK_PHASE_COLOR;
}

export const PHASE_ORDER = [
  "dispatched",
  "researching",
  "planning",
  "implementing",
  "validating",
  "shipping",
  "done",
];
