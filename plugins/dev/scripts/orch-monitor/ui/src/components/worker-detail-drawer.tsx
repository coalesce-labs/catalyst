import { useState, useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import { fmtSince, fmtTokens, fmtCost, phaseColor, PHASE_ORDER } from "@/lib/formatters";
import { effectiveCost, totalTokens } from "@/lib/computations";
import { StatusBadge } from "./ui/badge";
import { StatusDot } from "./ui/status-dot";
import { SectionLabel } from "./ui/panel";
import { PrBadge } from "./ui/pr-badge";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "./ui/sheet";
import {
  isWorkerDone,
  type WorkerState,
  type WorkerAnalytics,
  type LinearTicket,
  type StreamEvent,
  type WorkerTask,
} from "@/lib/types";
import {
  Terminal,
  Clock,
  DollarSign,
  Zap,
  RefreshCw,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  ListTodo,
  CheckCircle2,
  Circle,
  Loader2,
  RotateCw,
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
    case "turn": {
      const hasTools = event.turnTools && event.turnTools.length > 0;
      const hasText = event.text && event.text.length > 0;
      return (
        <div className="flex items-start gap-2 py-1">
          <span className="mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
          <div className="min-w-0 flex-1">
            {hasTools ? (
              <span className="font-mono text-[11px] text-accent">
                {event.turnTools!.join(", ")}
              </span>
            ) : hasText ? (
              <span className="truncate text-[11px] text-fg">
                {event.text!.slice(0, 100)}
              </span>
            ) : (
              <span className="text-[11px] text-muted">new turn</span>
            )}
          </div>
          <span className="shrink-0 font-mono text-[10px] text-muted tabular-nums">
            {fmtSince(age)}
          </span>
        </div>
      );
    }
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
    case "rate_limit": {
      const resets = event.rateLimitInfo?.resetsAt;
      const resetsIn = resets ? Math.max(0, Math.round((resets * 1000 - Date.now()) / 1000)) : null;
      return (
        <div className="flex items-center gap-2 py-1">
          <span className="mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full bg-red" />
          <span className="text-[11px] text-red">
            rate limited
            {resetsIn !== null && resetsIn > 0 && (
              <span className="text-muted"> resets {fmtSince(resetsIn)}</span>
            )}
          </span>
          <span className="ml-auto shrink-0 font-mono text-[10px] text-muted tabular-nums">
            {fmtSince(age)}
          </span>
        </div>
      );
    }
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

interface TaskListData {
  total: number;
  completed: number;
  inProgress: number;
  pending: number;
  tasks: WorkerTask[];
}

function TaskStatusIcon({ status }: { status: string }) {
  switch (status) {
    case "completed":
      return <CheckCircle2 className="h-3 w-3 text-green" />;
    case "in_progress":
      return <Loader2 className="h-3 w-3 animate-spin text-blue" />;
    default:
      return <Circle className="h-3 w-3 text-muted" />;
  }
}

type TaskStatus = "loading" | "ok" | "empty" | "error";

function TaskListSection({ pid }: { pid: number | null }) {
  const [taskData, setTaskData] = useState<TaskListData | null>(null);
  const [status, setStatus] = useState<TaskStatus>("loading");
  const [expanded, setExpanded] = useState(false);
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    if (!pid) {
      setStatus("empty");
      setTaskData(null);
      return;
    }
    let cancelled = false;

    async function fetchTasks() {
      try {
        const resp = await fetch(`/api/worker-tasks?pid=${pid}`);
        if (cancelled) return;
        if (!resp.ok) {
          setStatus("error");
          return;
        }
        const data = await resp.json();
        if (cancelled) return;
        if (data.tasks && data.tasks.tasks && data.tasks.tasks.length > 0) {
          setTaskData(data.tasks);
          setStatus("ok");
        } else {
          setTaskData(null);
          setStatus("empty");
        }
      } catch {
        if (!cancelled) setStatus("error");
      }
    }

    fetchTasks();
    const interval = setInterval(fetchTasks, 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [pid, retryKey]);

  const activeTask =
    status === "ok" && taskData
      ? taskData.tasks.find((t) => t.status === "in_progress")
      : undefined;

  const canExpand = status === "ok";

  return (
    <div className="border-b border-border-subtle px-4 py-3">
      <button
        onClick={() => canExpand && setExpanded(!expanded)}
        disabled={!canExpand}
        className={cn(
          "flex w-full items-center gap-1.5 text-left",
          !canExpand && "cursor-default",
        )}
      >
        {canExpand ? (
          expanded ? (
            <ChevronDown className="h-3 w-3 text-muted" />
          ) : (
            <ChevronRight className="h-3 w-3 text-muted" />
          )
        ) : (
          <span className="h-3 w-3" />
        )}
        <ListTodo className="h-3.5 w-3.5 text-muted" />
        <SectionLabel>Tasks</SectionLabel>
        {status === "ok" && taskData && (
          <span className="ml-auto font-mono text-[10px] text-muted tabular-nums">
            {taskData.completed}/{taskData.total}
          </span>
        )}
      </button>

      {status === "empty" && (
        <div className="mt-1.5 flex items-center gap-2 pl-5 text-[11px] text-muted">
          <span>No task list for this worker</span>
        </div>
      )}

      {status === "error" && (
        <div className="mt-1.5 flex items-center gap-2 pl-5 text-[11px] text-muted">
          <span>Task list unavailable</span>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setStatus("loading");
              setRetryKey((k) => k + 1);
            }}
            className="ml-auto flex items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-[10px] text-fg transition-colors hover:bg-surface-3"
          >
            <RotateCw className="h-3 w-3" />
            Retry
          </button>
        </div>
      )}

      {status === "ok" && taskData && (
        <>
          {/* Always show active task */}
          {activeTask && !expanded && (
            <div className="mt-1.5 flex items-center gap-2 pl-5">
              <Loader2 className="h-3 w-3 animate-spin text-blue" />
              <span className="truncate text-[11px] text-fg">
                {activeTask.activeForm || activeTask.subject}
              </span>
            </div>
          )}

          {/* Expanded: show all tasks */}
          {expanded && (
            <div className="mt-2 space-y-1 pl-5">
              {taskData.tasks.map((task) => (
                <div key={task.id} className="flex items-start gap-2">
                  <span className="mt-0.5">
                    <TaskStatusIcon status={task.status} />
                  </span>
                  <span
                    className={cn(
                      "text-[11px]",
                      task.status === "completed"
                        ? "text-muted line-through"
                        : task.status === "in_progress"
                          ? "text-fg"
                          : "text-muted",
                    )}
                  >
                    {task.subject}
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* Progress bar */}
          {taskData.total > 1 && (
            <div className="mt-2 h-1 overflow-hidden rounded-full bg-surface-3">
              <div
                className="h-full rounded-full bg-green transition-all"
                style={{
                  width: `${(taskData.completed / taskData.total) * 100}%`,
                }}
              />
            </div>
          )}
        </>
      )}
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
    <Sheet open onOpenChange={(open) => { if (!open) onClose(); }}>
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-0 border-l border-border bg-surface-1 p-0 sm:max-w-[540px]"
      >
        {/* Header */}
        <SheetHeader className="flex flex-row items-center gap-2 space-y-0 border-b border-border px-4 py-3 pr-12">
          <div className="min-w-0 flex-1">
            <SheetTitle asChild>
              <div className="flex items-center gap-2 text-sm font-bold text-fg">
                <span className="font-mono">{ticket}</span>
                <StatusBadge status={worker.status || "unknown"} />
                {worker.pid && !isWorkerDone(worker.status) && (
                  <span className="flex items-center gap-1">
                    <StatusDot alive={worker.alive} />
                  </span>
                )}
              </div>
            </SheetTitle>
            {linear && (
              <span className="mt-0.5 block truncate text-[12px] text-muted" title={linear.title}>
                {linear.title}
              </span>
            )}
            <SheetDescription className="sr-only">
              Worker detail for {ticket}
              {linear ? `: ${linear.title}` : ""}.
            </SheetDescription>
          </div>
        </SheetHeader>

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

          {/* Task list */}
          <TaskListSection pid={worker.pid} />

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
                <PrBadge
                  number={worker.pr.number}
                  url={worker.pr.url}
                  state={worker.pr.state ?? worker.prState}
                  mergeStateStatus={worker.pr.mergeStateStatus}
                  isDraft={worker.pr.isDraft}
                  mergedAt={worker.pr.mergedAt ?? worker.prMergedAt ?? undefined}
                  title={worker.pr.title}
                />
                {worker.pr.title && (
                  <span className="truncate text-[12px] text-muted">
                    {worker.pr.title}
                  </span>
                )}
              </div>
              {(worker.pr.mergeStateStatus || worker.pr.mergedAt) && (
                <div className="mt-1.5 flex items-center gap-2 pl-0.5 text-[11px] text-muted">
                  {worker.pr.mergeStateStatus && (
                    <span className="font-mono uppercase tracking-wide">
                      {worker.pr.mergeStateStatus}
                    </span>
                  )}
                  {worker.pr.mergedAt && (
                    <span>
                      merged {new Date(worker.pr.mergedAt).toLocaleString()}
                    </span>
                  )}
                </div>
              )}
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
      </SheetContent>
    </Sheet>
  );
}
