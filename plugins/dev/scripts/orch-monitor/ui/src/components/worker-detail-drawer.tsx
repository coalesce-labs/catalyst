import { useState, useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import { fmtSince, fmtTokens, fmtCost, phaseColor, PHASE_ORDER } from "@/lib/formatters";
import { effectiveCost, totalTokens } from "@/lib/computations";
import { StatusBadge } from "./ui/badge";
import { StatusDot } from "./ui/status-dot";
import { ExternalLink } from "./ui/external-link";
import { SectionLabel } from "./ui/panel";
import type {
  WorkerState,
  WorkerAnalytics,
  LinearTicket,
  StreamEvent,
} from "@/lib/types";
import {
  X,
  Terminal,
  Clock,
  DollarSign,
  Zap,
  RefreshCw,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
} from "lucide-react";

interface WorkerDetailDrawerProps {
  orchId: string;
  ticket: string;
  worker: WorkerState;
  analytics: WorkerAnalytics | null;
  linear: LinearTicket | null;
  onClose: () => void;
}

function MetricPill({
  icon,
  label,
  value,
  className,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-1.5 rounded-md border border-border bg-surface-3/50 px-2.5 py-1.5",
        className,
      )}
    >
      {icon}
      <span className="text-[10px] uppercase text-muted">{label}</span>
      <span className="font-mono text-[12px] font-semibold text-fg tabular-nums">
        {value}
      </span>
    </div>
  );
}

function StreamEventRow({ event }: { event: StreamEvent }) {
  const age = (Date.now() - event.ts) / 1000;
  switch (event.type) {
    case "tool_start":
      return (
        <div className="flex items-start gap-2 py-1">
          <span className="mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full bg-blue" />
          <div className="min-w-0 flex-1">
            <span className="font-mono text-[11px] text-blue">
              {event.tool || "tool"}
            </span>
            {event.toolInput && (
              <span className="ml-1.5 truncate text-[11px] text-muted">
                {event.toolInput.slice(0, 80)}
              </span>
            )}
          </div>
          <span className="shrink-0 font-mono text-[10px] text-muted tabular-nums">
            {fmtSince(age)}
          </span>
        </div>
      );
    case "text":
      return (
        <div className="flex items-start gap-2 py-1">
          <span className="mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full bg-green" />
          <span className="min-w-0 flex-1 truncate text-[11px] text-fg">
            {event.text?.slice(0, 100) || "..."}
          </span>
          <span className="shrink-0 font-mono text-[10px] text-muted tabular-nums">
            {fmtSince(age)}
          </span>
        </div>
      );
    case "turn":
      return (
        <div className="flex items-center gap-2 py-1">
          <span className="mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
          <span className="text-[11px] text-muted">new turn</span>
          <span className="ml-auto shrink-0 font-mono text-[10px] text-muted tabular-nums">
            {fmtSince(age)}
          </span>
        </div>
      );
    case "retry":
      return (
        <div className="flex items-center gap-2 py-1">
          <span className="mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full bg-yellow" />
          <span className="text-[11px] text-yellow">
            retry {event.retryInfo?.attempt}/{event.retryInfo?.maxRetries}
          </span>
          <span className="ml-auto shrink-0 font-mono text-[10px] text-muted tabular-nums">
            {fmtSince(age)}
          </span>
        </div>
      );
    case "result":
      return (
        <div className="flex items-center gap-2 py-1">
          <span className="mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full bg-green" />
          <span className="text-[11px] font-semibold text-green">complete</span>
          <span className="ml-auto shrink-0 font-mono text-[10px] text-muted tabular-nums">
            {fmtSince(age)}
          </span>
        </div>
      );
    default:
      return null;
  }
}

function PhaseTimeline({ worker }: { worker: WorkerState }) {
  const phaseTs = worker.phaseTimestamps || {};
  const phases = PHASE_ORDER.filter((p) => phaseTs[p]);
  if (phases.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1">
      {PHASE_ORDER.map((phase) => {
        const ts = phaseTs[phase];
        const isCurrent = worker.status === phase;
        const isReached = !!ts;
        return (
          <div
            key={phase}
            className={cn(
              "rounded px-1.5 py-0.5 text-[10px] font-medium",
              isReached
                ? "border border-transparent"
                : "border border-border-subtle text-muted/40",
              isCurrent && "ring-1 ring-accent/50",
            )}
            style={
              isReached
                ? { backgroundColor: phaseColor(phase) + "28", color: phaseColor(phase) }
                : undefined
            }
            title={ts ? new Date(ts).toLocaleString() : undefined}
          >
            {phase}
          </div>
        );
      })}
    </div>
  );
}

export function WorkerDetailDrawer({
  orchId,
  ticket,
  worker,
  analytics,
  linear,
  onClose,
}: WorkerDetailDrawerProps) {
  const [streamEvents, setStreamEvents] = useState<StreamEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [signalOpen, setSignalOpen] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function fetchStream() {
      try {
        const resp = await fetch(
          `/api/worker-stream/${encodeURIComponent(orchId)}/${encodeURIComponent(ticket)}?limit=40`,
        );
        if (!resp.ok || cancelled) return;
        const data = await resp.json();
        if (!cancelled) {
          setStreamEvents(data.events || []);
          setLoading(false);
        }
      } catch {
        if (!cancelled) setLoading(false);
      }
    }

    fetchStream();
    pollRef.current = setInterval(fetchStream, 3000);

    return () => {
      cancelled = true;
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [orchId, ticket]);

  const cost = effectiveCost(worker, analytics);
  const tokens = totalTokens(worker, analytics);
  const elapsed = worker.startedAt
    ? (Date.now() - Date.parse(worker.startedAt)) / 1000
    : 0;

  return (
    <>
      <div
        className="fixed inset-0 z-40 bg-black/40"
        onClick={onClose}
      />
      <div className="animate-drawer-in fixed inset-y-0 right-0 z-50 flex w-[420px] max-w-[90vw] flex-col border-l border-border bg-surface-1 shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="font-mono text-sm font-bold text-fg">{ticket}</span>
              <StatusBadge status={worker.status || "unknown"} />
              {worker.pid && (
                <span className="flex items-center gap-1">
                  <StatusDot alive={worker.alive} />
                </span>
              )}
            </div>
            {linear && (
              <span className="mt-0.5 block truncate text-[12px] text-muted" title={linear.title}>
                {linear.title}
              </span>
            )}
          </div>
          <button
            onClick={onClose}
            className="rounded-md p-1.5 text-muted transition-colors hover:bg-surface-3 hover:text-fg"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto">
          {/* Metrics strip */}
          <div className="flex flex-wrap gap-2 border-b border-border-subtle px-4 py-3">
            <MetricPill
              icon={<Clock className="h-3 w-3 text-muted" />}
              label="elapsed"
              value={fmtSince(elapsed)}
            />
            <MetricPill
              icon={<DollarSign className="h-3 w-3 text-muted" />}
              label="cost"
              value={cost > 0 ? fmtCost(cost) : "—"}
            />
            <MetricPill
              icon={<Zap className="h-3 w-3 text-muted" />}
              label="tokens"
              value={tokens > 0 ? fmtTokens(tokens) : "—"}
            />
            {worker.activity && (
              <>
                <MetricPill
                  icon={<Terminal className="h-3 w-3 text-muted" />}
                  label="tools"
                  value={String(worker.activity.toolCalls)}
                />
                <MetricPill
                  icon={<RefreshCw className="h-3 w-3 text-muted" />}
                  label="turns"
                  value={String(worker.activity.turns)}
                />
              </>
            )}
            {worker.activity?.hasRetries && (
              <MetricPill
                icon={<AlertTriangle className="h-3 w-3 text-yellow" />}
                label="retries"
                value="yes"
                className="border-yellow/30"
              />
            )}
          </div>

          {/* Phase timeline */}
          {worker.phaseTimestamps && Object.keys(worker.phaseTimestamps).length > 0 && (
            <div className="border-b border-border-subtle px-4 py-3">
              <SectionLabel>Phase Timeline</SectionLabel>
              <div className="mt-2">
                <PhaseTimeline worker={worker} />
              </div>
            </div>
          )}

          {/* Current activity */}
          {worker.activity?.currentTool && (
            <div className="border-b border-border-subtle px-4 py-3">
              <SectionLabel>Current Tool</SectionLabel>
              <div className="mt-1.5 flex items-center gap-2">
                <span className="h-2 w-2 rounded-full bg-blue animate-live-pulse" />
                <span className="font-mono text-[13px] text-blue">
                  {worker.activity.currentTool}
                </span>
              </div>
            </div>
          )}

          {/* PR info */}
          {worker.pr && (
            <div className="border-b border-border-subtle px-4 py-3">
              <SectionLabel>Pull Request</SectionLabel>
              <div className="mt-1.5 flex items-center gap-2">
                <ExternalLink href={worker.pr.url}>
                  #{worker.pr.number}
                </ExternalLink>
                {worker.pr.title && (
                  <span className="truncate text-[12px] text-muted">
                    {worker.pr.title}
                  </span>
                )}
                {worker.prState && (
                  <StatusBadge status={worker.prState.toLowerCase()} />
                )}
              </div>
            </div>
          )}

          {/* Live activity feed */}
          <div className="px-4 py-3">
            <SectionLabel>Activity Feed</SectionLabel>
            <div className="mt-2 space-y-0.5">
              {loading ? (
                <div className="py-4 text-center text-[12px] text-muted">
                  Loading stream...
                </div>
              ) : streamEvents.length === 0 ? (
                <div className="py-4 text-center text-[12px] text-muted">
                  No stream data available
                </div>
              ) : (
                streamEvents
                  .slice()
                  .reverse()
                  .map((ev, i) => <StreamEventRow key={i} event={ev} />)
              )}
            </div>
          </div>

          {/* Signal file (collapsible raw view) */}
          <div className="border-t border-border-subtle px-4 py-3">
            <button
              onClick={() => setSignalOpen(!signalOpen)}
              className="flex items-center gap-1.5 text-muted transition-colors hover:text-fg"
            >
              {signalOpen ? (
                <ChevronDown className="h-3 w-3" />
              ) : (
                <ChevronRight className="h-3 w-3" />
              )}
              <SectionLabel>Signal Data</SectionLabel>
            </button>
            {signalOpen && (
              <pre className="mt-2 max-h-64 overflow-auto rounded border border-border bg-surface-3 p-3 font-mono text-[11px] text-fg">
                {JSON.stringify(worker, null, 2)}
              </pre>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
