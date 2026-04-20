import { useState, useEffect, useRef, useMemo } from "react";
import { cn } from "@/lib/utils";
import { fmtSince, fmtTokens, fmtCost } from "@/lib/formatters";
import { ticketToWaveMap, effectiveCost, totalTokens, isAbandoned } from "@/lib/computations";
import { useSort } from "@/hooks/use-sort";
import { SortHeader } from "./ui/sort-header";
import { StatusBadge } from "./ui/badge";
import { StatusDot } from "./ui/status-dot";
import { ExternalLink } from "./ui/external-link";
import { EmptyState } from "./ui/empty-state";
import { SearchInput } from "./ui/search-input";
import {
  isWorkerDone,
  type OrchestratorState,
  type WorkerState,
  type WorkerAnalytics,
  type LinearTicket,
} from "@/lib/types";
import { Users } from "lucide-react";

interface WorkerTableProps {
  orch: OrchestratorState;
  getAnalytics: (orchId: string) => Record<string, WorkerAnalytics | null>;
  getLinear: (ticket: string) => LinearTicket | null;
  staleThreshold: number;
  filterWave?: number | null;
  onWorkerSelect?: (ticket: string) => void;
  selectedTicket?: string | null;
}

function LabelChip({ label }: { label: string }) {
  const lower = label.toLowerCase();
  const cls =
    lower === "bug"
      ? "bg-red/16 text-[#f4a8a8]"
      : lower === "feature"
        ? "bg-blue/16 text-[#9ec7f4]"
        : "bg-surface-3 text-muted border border-border";
  return (
    <span className={cn("rounded px-1.5 py-px font-mono text-[10px]", cls)}>
      {label}
    </span>
  );
}

function LiveTimer({
  updatedAt,
  staleThreshold,
}: {
  updatedAt: string;
  staleThreshold: number;
}) {
  const ref = useRef<HTMLTableCellElement>(null);
  const initialSecs = updatedAt
    ? Math.max(0, (Date.now() - Date.parse(updatedAt)) / 1000)
    : 0;

  useEffect(() => {
    if (!updatedAt) return;
    const id = setInterval(() => {
      if (!ref.current) return;
      const secs = Math.max(0, (Date.now() - Date.parse(updatedAt)) / 1000);
      ref.current.textContent = fmtSince(secs);
      ref.current.className = cn(
        "px-3 py-2.5 font-mono text-[12px] whitespace-nowrap tabular-nums",
        secs > staleThreshold ? "text-red" : "text-muted",
      );
    }, 1000);
    return () => clearInterval(id);
  }, [updatedAt, staleThreshold]);

  return (
    <td
      ref={ref}
      className={cn(
        "px-3 py-2.5 font-mono text-[12px] whitespace-nowrap tabular-nums",
        initialSecs > staleThreshold ? "text-red" : "text-muted",
      )}
    >
      {fmtSince(initialSecs)}
    </td>
  );
}

function ActivityCell({ w }: { w: WorkerState }) {
  const tool = w.activity?.currentTool;
  const tasks = w.activity?.taskSummary;
  const hasContent = tool || tasks;

  if (!hasContent) {
    return <span className="text-muted">—</span>;
  }

  return (
    <div className="flex flex-col gap-0.5">
      {tool && (
        <span className="flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full bg-blue animate-live-pulse" />
          <span className="font-mono text-[11px] text-blue truncate max-w-[120px]">
            {tool}
          </span>
        </span>
      )}
      {tasks && tasks.total > 0 && (
        <span className="flex items-center gap-1.5">
          <span className="inline-flex h-[14px] items-center gap-0.5 rounded bg-surface-3 px-1 font-mono text-[10px] text-muted tabular-nums">
            {tasks.completed}/{tasks.total}
          </span>
          {tasks.activeTask && (
            <span className="truncate text-[10px] text-muted max-w-[100px]" title={tasks.activeTask}>
              {tasks.activeTask}
            </span>
          )}
        </span>
      )}
    </div>
  );
}

function WorkerCell({ w }: { w: WorkerState }) {
  if (isWorkerDone(w.status)) {
    return <span className="text-muted">—</span>;
  }
  if (w.alive === true) {
    return (
      <span className="flex items-center gap-1.5">
        <StatusDot alive={true} />
        <span className="text-[12px] text-green">running</span>
      </span>
    );
  }
  if (w.pid && w.alive === false) {
    return (
      <span className="flex items-center gap-1.5" title="Worker process died">
        <span className="inline-block h-2 w-2 rounded-full bg-red shadow-[0_0_6px_theme(colors.red)]" />
        <span className="text-[12px] font-medium text-red">died</span>
      </span>
    );
  }
  return <span className="text-muted">—</span>;
}

function workerCellSortRank(w: WorkerState): number {
  if (isWorkerDone(w.status)) return 2;
  if (w.alive === false) return 1;
  return 0;
}

function WorkerRow({
  ticket,
  w,
  waveNum,
  analytics,
  linear,
  staleThreshold,
  onClick,
  isSelected,
}: {
  ticket: string;
  w: WorkerState;
  waveNum: number | null;
  analytics: WorkerAnalytics | null;
  linear: LinearTicket | null;
  staleThreshold: number;
  onClick?: () => void;
  isSelected?: boolean;
}) {
  const ticketUrl =
    linear?.url || `https://linear.app/issue/${encodeURIComponent(ticket)}`;
  const cost = effectiveCost(w, analytics);
  const tokens = totalTokens(w, analytics);
  const isMerged = w.prState === "MERGED";
  const isClosed = w.prState === "CLOSED";
  const isAbandonedRow = isAbandoned(w.status);

  return (
    <tr
      onClick={onClick}
      className={cn(
        "border-b border-border-subtle transition-colors hover:bg-surface-3",
        onClick && "cursor-pointer",
        isSelected && "bg-surface-3/80 ring-1 ring-inset ring-accent/20",
        isMerged && "opacity-80",
        isClosed && "opacity-70",
        isAbandonedRow && "opacity-70",
      )}
    >
      <td className="px-3 py-2.5 font-mono text-[12px] text-muted">
        {waveNum ?? "—"}
      </td>
      <td className="px-3 py-2.5">
        <ExternalLink href={ticketUrl} className="font-semibold">
          {ticket}
        </ExternalLink>
      </td>
      <td className="max-w-[320px] px-3 py-2.5">
        {linear ? (
          <div>
            <span className="block truncate text-[13px] text-fg" title={linear.title}>
              {linear.title}
            </span>
            {linear.project && (
              <span className="text-[11px] text-muted">{linear.project}</span>
            )}
            {linear.labels && linear.labels.length > 0 && (
              <span className="ml-1.5 inline-flex gap-1">
                {linear.labels.slice(0, 3).map((l) => (
                  <LabelChip key={l} label={l} />
                ))}
              </span>
            )}
          </div>
        ) : (
          <span className="text-muted">—</span>
        )}
      </td>
      <td className="px-3 py-2.5">
        <StatusBadge status={w.status || "unknown"} />
      </td>
      <td className="px-3 py-2.5 text-[12px] text-muted">{w.phase ?? 0}</td>
      <td className="px-3 py-2.5">
        <WorkerCell w={w} />
      </td>
      <td className="px-3 py-2.5">
        {w.pr ? (
          <span className="flex items-center gap-1.5">
            <ExternalLink
              href={w.pr.url}
              muted={isClosed}
              strikethrough={isClosed}
            >
              #{w.pr.number}
            </ExternalLink>
            {isMerged && (
              <span className="text-[11px] font-semibold text-green">merged</span>
            )}
          </span>
        ) : (
          <span className="text-muted">—</span>
        )}
      </td>
      <td className="px-3 py-2.5 text-right font-mono text-[12px] tabular-nums">
        {cost > 0 ? (
          <span className="text-fg">{fmtCost(cost)}</span>
        ) : (
          <span className="text-muted">—</span>
        )}
      </td>
      <td className="px-3 py-2.5 text-right font-mono text-[12px] tabular-nums">
        {tokens > 0 ? (
          <span className="text-fg">{fmtTokens(tokens)}</span>
        ) : (
          <span className="text-muted">—</span>
        )}
      </td>
      <td className="px-3 py-2.5">
        <ActivityCell w={w} />
      </td>
      <LiveTimer updatedAt={w.updatedAt} staleThreshold={staleThreshold} />
    </tr>
  );
}

type WorkerSortKey =
  | "wave"
  | "ticket"
  | "title"
  | "status"
  | "phase"
  | "worker"
  | "pr"
  | "cost"
  | "tokens"
  | "activity"
  | "lastUpdate";

const COL_HEADERS: {
  label: string;
  sortKey: WorkerSortKey;
  align: "left" | "right";
}[] = [
  { label: "Wave", sortKey: "wave", align: "left" },
  { label: "Ticket", sortKey: "ticket", align: "left" },
  { label: "Title", sortKey: "title", align: "left" },
  { label: "Status", sortKey: "status", align: "left" },
  { label: "Phase", sortKey: "phase", align: "left" },
  { label: "Worker", sortKey: "worker", align: "left" },
  { label: "PR", sortKey: "pr", align: "left" },
  { label: "Cost", sortKey: "cost", align: "right" },
  { label: "Tokens", sortKey: "tokens", align: "right" },
  { label: "Activity", sortKey: "activity", align: "left" },
  { label: "Last update", sortKey: "lastUpdate", align: "left" },
];

const STATUS_FILTERS = ["all", "active", "done", "failed"] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];

function matchesStatusFilter(
  status: string | undefined,
  filter: StatusFilter,
): boolean {
  if (filter === "all") return true;
  const s = (status || "").toLowerCase();
  if (filter === "done") return s === "done" || s === "merged";
  if (filter === "failed") return s === "failed" || s === "stalled";
  return s !== "done" && s !== "merged" && s !== "failed" && s !== "stalled";
}

export function WorkerTable({
  orch,
  getAnalytics,
  getLinear,
  staleThreshold,
  filterWave,
  onWorkerSelect,
  selectedTicket,
}: WorkerTableProps) {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const { sort, toggleSort, sortFn } = useSort<WorkerSortKey>("wave");
  const tToW = ticketToWaveMap(orch);
  const analyticsMap = getAnalytics(orch.id);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return Object.entries(orch.workers).filter(([t, w]) => {
      if (filterWave != null && tToW[t] !== filterWave) return false;
      if (!matchesStatusFilter(w.status, statusFilter)) return false;
      if (q) {
        const lin = getLinear(t);
        const haystack = [t, w.status, lin?.title, lin?.project]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
  }, [orch.workers, filterWave, tToW, search, statusFilter, getLinear]);

  const entries = useMemo(
    () =>
      sortFn(filtered, ([t, w], key) => {
        switch (key) {
          case "wave":
            return tToW[t] ?? 999;
          case "ticket":
            return t;
          case "title":
            return getLinear(t)?.title ?? null;
          case "status":
            return w.status ?? null;
          case "phase":
            return w.phase ?? 0;
          case "worker":
            return workerCellSortRank(w as WorkerState);
          case "pr":
            return w.pr?.number ?? null;
          case "cost":
            return effectiveCost(w as WorkerState, analyticsMap[t] || null);
          case "tokens":
            return totalTokens(w as WorkerState, analyticsMap[t] || null);
          case "activity":
            return (w as WorkerState).activity?.currentTool ?? null;
          case "lastUpdate":
            return w.updatedAt ? Date.parse(w.updatedAt) : null;
        }
      }),
    [filtered, sortFn, tToW, getLinear, analyticsMap],
  );

  const totalCount = Object.keys(orch.workers).length;

  return (
    <div>
      {totalCount > 3 && (
        <div className="flex flex-wrap items-center gap-3 border-b border-border-subtle px-3 py-2">
          <SearchInput
            value={search}
            onChange={setSearch}
            placeholder="Filter workers..."
            className="w-56"
          />
          <div className="flex gap-1">
            {STATUS_FILTERS.map((f) => (
              <button
                key={f}
                onClick={() => setStatusFilter(f)}
                className={cn(
                  "rounded-md px-2.5 py-1 text-[11px] font-medium capitalize transition-colors",
                  statusFilter === f
                    ? "bg-accent/15 text-accent"
                    : "text-muted hover:bg-surface-3 hover:text-fg",
                )}
              >
                {f}
              </button>
            ))}
          </div>
          {(search || statusFilter !== "all") && (
            <span className="text-[11px] text-muted">
              {entries.length}/{totalCount}
            </span>
          )}
        </div>
      )}

      {!entries.length ? (
        <EmptyState
          icon={Users}
          message={
            search || statusFilter !== "all"
              ? "No workers match filters"
              : filterWave != null
                ? `No workers in wave ${filterWave}`
                : "No workers"
          }
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-border bg-surface-2">
                {COL_HEADERS.map((h) => (
                  <SortHeader
                    key={h.sortKey}
                    label={h.label}
                    sortKey={h.sortKey}
                    sort={sort}
                    onSort={toggleSort}
                    align={h.align}
                  />
                ))}
              </tr>
            </thead>
            <tbody>
              {entries.map(([t, w]) => (
                <WorkerRow
                  key={t}
                  ticket={t}
                  w={w as WorkerState}
                  waveNum={tToW[t] ?? (w as WorkerState).wave}
                  analytics={analyticsMap[t] || null}
                  linear={getLinear(t)}
                  staleThreshold={staleThreshold}
                  onClick={onWorkerSelect ? () => onWorkerSelect(t) : undefined}
                  isSelected={selectedTicket === t}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
