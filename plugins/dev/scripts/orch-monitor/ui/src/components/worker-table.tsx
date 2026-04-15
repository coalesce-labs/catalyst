import { useState, useEffect, useRef, useMemo } from "react";
import { cn } from "@/lib/utils";
import { fmtSince, fmtTokens, fmtCost } from "@/lib/formatters";
import { ticketToWaveMap, effectiveCost, totalTokens } from "@/lib/computations";
import { StatusBadge } from "./ui/badge";
import { StatusDot } from "./ui/status-dot";
import { ExternalLink } from "./ui/external-link";
import { EmptyState } from "./ui/empty-state";
import { SearchInput } from "./ui/search-input";
import type {
  OrchestratorState,
  WorkerState,
  WorkerAnalytics,
  LinearTicket,
} from "@/lib/types";
import { Users } from "lucide-react";

interface WorkerTableProps {
  orch: OrchestratorState;
  getAnalytics: (orchId: string) => Record<string, WorkerAnalytics | null>;
  getLinear: (ticket: string) => LinearTicket | null;
  staleThreshold: number;
  filterWave?: number | null;
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

function WorkerRow({
  ticket,
  w,
  waveNum,
  analytics,
  linear,
  staleThreshold,
}: {
  ticket: string;
  w: WorkerState;
  waveNum: number | null;
  analytics: WorkerAnalytics | null;
  linear: LinearTicket | null;
  staleThreshold: number;
}) {
  const ticketUrl =
    linear?.url || `https://linear.app/issue/${encodeURIComponent(ticket)}`;
  const cost = effectiveCost(w, analytics);
  const tokens = totalTokens(w, analytics);
  const isMerged = w.prState === "MERGED";
  const isClosed = w.prState === "CLOSED";

  return (
    <tr
      className={cn(
        "border-b border-border-subtle transition-colors hover:bg-surface-3",
        isMerged && "opacity-80",
        isClosed && "opacity-70",
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
        {w.pid ? (
          <span className="flex items-center gap-1.5">
            <StatusDot alive={w.alive} />
            <span className={cn("text-[12px]", w.alive ? "text-green" : "text-muted")}>
              {w.alive ? "alive" : "dead"}
            </span>
            <span className="font-mono text-[11px] text-muted">{w.pid}</span>
          </span>
        ) : (
          <span className="text-muted">—</span>
        )}
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
      <LiveTimer updatedAt={w.updatedAt} staleThreshold={staleThreshold} />
    </tr>
  );
}

const COL_HEADERS = [
  { label: "Wave", align: "left" as const },
  { label: "Ticket", align: "left" as const },
  { label: "Title", align: "left" as const },
  { label: "Status", align: "left" as const },
  { label: "Phase", align: "left" as const },
  { label: "Process", align: "left" as const },
  { label: "PR", align: "left" as const },
  { label: "Cost", align: "right" as const },
  { label: "Tokens", align: "right" as const },
  { label: "Last update", align: "left" as const },
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
}: WorkerTableProps) {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const tToW = ticketToWaveMap(orch);
  const analytics = getAnalytics(orch.id);

  const entries = useMemo(() => {
    const q = search.toLowerCase();
    return Object.entries(orch.workers)
      .filter(([t, w]) => {
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
      })
      .sort((a, b) => {
        const wa = tToW[a[0]] ?? 999;
        const wb = tToW[b[0]] ?? 999;
        if (wa !== wb) return wa - wb;
        return a[0].localeCompare(b[0]);
      });
  }, [orch.workers, filterWave, tToW, search, statusFilter, getLinear]);

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
                  <th
                    key={h.label}
                    className={cn(
                      "px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-muted",
                      h.align === "right" ? "text-right" : "text-left",
                    )}
                  >
                    {h.label}
                  </th>
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
                  analytics={analytics[t] || null}
                  linear={getLinear(t)}
                  staleThreshold={staleThreshold}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
