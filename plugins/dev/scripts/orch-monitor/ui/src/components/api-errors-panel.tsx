import { AlertTriangle } from "lucide-react";
import { Panel, PanelHeader, SectionLabel } from "./ui/panel";
import { EmptyState } from "./ui/empty-state";
import type { OtelLogEntry } from "@/lib/types";

interface ApiErrorsPanelProps {
  errors: OtelLogEntry[] | null;
  configured: boolean;
}

const MAX_ROWS = 5;
const MAX_MSG_CHARS = 120;

export function ApiErrorsPanel({ errors, configured }: ApiErrorsPanelProps) {
  if (!configured) return null;

  return (
    <Panel>
      <PanelHeader className="flex items-center justify-between">
        <SectionLabel>API errors · last 1h</SectionLabel>
        <AlertTriangle className="h-3.5 w-3.5 text-muted" />
      </PanelHeader>
      <div>{renderBody(errors)}</div>
    </Panel>
  );
}

function renderBody(errors: OtelLogEntry[] | null) {
  if (errors === null) {
    return (
      <div className="flex flex-col gap-1.5 p-3">
        {Array.from({ length: MAX_ROWS }).map((_, i) => (
          <div
            key={i}
            className="h-4 animate-pulse rounded bg-surface-3 opacity-60"
          />
        ))}
      </div>
    );
  }

  if (errors.length === 0) {
    return (
      <EmptyState icon={AlertTriangle} message="No API errors in the last hour" />
    );
  }

  // Loki streams aren't guaranteed to arrive newest-first when concatenated across streams.
  const sorted = [...errors].sort((a, b) => tsCompare(b.timestamp, a.timestamp));
  const recent = sorted.slice(0, MAX_ROWS);

  return (
    <div>
      {recent.map((entry, i) => {
        const ts = formatTimestamp(entry.timestamp);
        const kind = entry.labels["error_type"] ?? entry.labels["level"] ?? "error";
        const msg = truncate(extractMessage(entry.line), MAX_MSG_CHARS);
        return (
          <div
            key={i}
            className="flex items-baseline gap-2 border-b border-border-subtle px-3 py-1.5 font-mono text-[12px] last:border-b-0"
          >
            <span className="shrink-0 text-muted tabular-nums">{ts}</span>
            <span className="shrink-0 rounded bg-[#5a2a2a] px-1.5 py-px text-[10px] uppercase tracking-wider text-[#f4a8a8]">
              {kind}
            </span>
            <span className="min-w-0 flex-1 truncate text-fg" title={entry.line}>
              {msg}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function formatTimestamp(ts: string): string {
  // Loki timestamps are nanoseconds as strings; fall back to raw when unparseable.
  const ms = parseLokiTimestamp(ts);
  if (ms === null) return ts.slice(0, 8);
  const d = new Date(ms);
  return d.toLocaleTimeString("en-US", { hour12: false });
}

function parseLokiTimestamp(ts: string): number | null {
  if (!/^\d+$/.test(ts)) {
    const d = Date.parse(ts);
    return Number.isFinite(d) ? d : null;
  }
  // Nanoseconds → ms
  const n = Number(ts);
  if (!Number.isFinite(n)) return null;
  return Math.floor(n / 1_000_000);
}

function tsCompare(a: string, b: string): number {
  const am = parseLokiTimestamp(a);
  const bm = parseLokiTimestamp(b);
  if (am !== null && bm !== null) return am - bm;
  return a.localeCompare(b);
}

function extractMessage(line: string): string {
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    const body = parsed["body"] ?? parsed["message"] ?? parsed["msg"];
    if (typeof body === "string") return body;
  } catch {
    // Not JSON; fall through to raw line.
  }
  return line;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}
