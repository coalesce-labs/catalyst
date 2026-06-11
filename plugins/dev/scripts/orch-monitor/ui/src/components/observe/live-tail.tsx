// live-tail.tsx — the TELEMETRY P1 panel body (OBS-6): a scrolling, worker-
// grouped tail of the fleet's claude-code activity, with filter chips.
//
// Built from scroll-area.tsx (the internal scroll so the panel is height-capped
// and the hero stays the first paint, layout spec §5 violation #4) + toggle-group
// chips (worker / event-type / errors-only). All grouping/filtering is the PURE
// logic in tail-group.ts; this file is the skin only. Absent fields render dimmed
// (text-muted), NEVER fabricated (Principle 6). Row tint for errors uses the
// health red token (text-red), not a categorical chart color (Principle 3/8).
//
// This component renders the LIVE state's children — the surrounding ChartCard
// (dataSource="[loki]") owns the unconfigured / unreachable / empty honesty
// states, so this never has to draw its own "no data" placeholder.

import { useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import type { TailRow } from "@/lib/types";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Badge } from "@/components/ui/badge";
import { ChevronDown, ChevronRight } from "lucide-react";
import {
  type TailFilter,
  type TailWorkerRef,
  EMPTY_TAIL_FILTER,
  bucketKeyFactory,
  filterTailRows,
  groupTailByWorker,
  isErrorRow,
  UNATTRIBUTED_KEY,
} from "./tail-group";

export interface LiveTailProps {
  /** Newest-first parsed tail rows (from /api/otel/tail). */
  rows: TailRow[];
  /** Board workers, for sessionId → ticket·phase attribution. */
  workers: TailWorkerRef[];
  /** Drill: open a worker's history page (passes the worker RUN id for /worker/$id). */
  onOpenWorker?: (workerName: string) => void;
  /** A cross-panel drill seed (P3 tool / P4 model click). When it changes the tail
   *  applies it as a filter so "show me what this tool/model is doing" lands here.
   *  Carries a nonce so re-clicking the SAME tool/model re-applies (the value alone
   *  wouldn't change). model has no tail filter axis, so an erroring model drills
   *  to errors-only (design §3.1: "or errors-only if error% is the interesting axis"). */
  focusFilter?: {
    tool?: string;
    eventType?: string;
    errorsOnly?: boolean;
    nonce: number;
  } | null;
}

/** Format a row timestamp as HH:MM:SS (local) — the terminal-style left gutter. */
function clock(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Short, human event name: strip the `claude_code.` prefix for density. */
function shortEvent(name: string | null): string {
  if (!name) return "event";
  return name.replace(/^claude_code\./, "");
}

/** A small dim/lit cell — dim when the value is absent (never fabricated). */
function Cell({ value, className }: { value: string | null; className?: string }) {
  if (value === null || value === "") {
    return <span className="text-muted/40">—</span>;
  }
  return <span className={className}>{value}</span>;
}

function TailRowLine({ row }: { row: TailRow }) {
  const err = isErrorRow(row);
  const dur = row.durationMs !== null ? `${(row.durationMs / 1000).toFixed(1)}s` : null;
  const cost = row.costUsd !== null ? `$${row.costUsd.toFixed(2)}` : null;
  return (
    <div
      className={cn(
        "flex items-baseline gap-2 px-3 py-1 font-mono text-[11px] leading-[1.5]",
        "border-b border-border/40 last:border-b-0",
        err && "bg-red/5",
      )}
    >
      <span className="shrink-0 text-muted/60 tabular-nums">{clock(row.ts)}</span>
      <span className={cn("shrink-0", err ? "text-red" : "text-fg/80")}>
        {shortEvent(row.eventName)}
      </span>
      <Cell value={row.toolName} className="shrink-0 text-accent" />
      <Cell value={row.model} className="shrink-0 text-muted" />
      <span className="ml-auto flex shrink-0 items-center gap-2 text-muted tabular-nums">
        <Cell value={dur} />
        <Cell value={cost} />
      </span>
    </div>
  );
}

function WorkerGroupHeader({
  label,
  count,
  open,
  ticket,
  onToggle,
  onOpenWorker,
}: {
  label: string;
  count: number;
  open: boolean;
  ticket: string | null;
  onToggle: () => void;
  onOpenWorker?: () => void;
}) {
  const Icon = open ? ChevronDown : ChevronRight;
  return (
    <div className="sticky top-0 z-10 flex items-center gap-1.5 border-b border-border bg-surface-1/95 px-2 py-1 backdrop-blur">
      <button
        type="button"
        onClick={onToggle}
        className="flex items-center gap-1 text-[11px] font-medium text-fg hover:text-accent"
        aria-expanded={open}
      >
        <Icon className="h-3.5 w-3.5 text-muted" />
        <span className="font-mono">{label}</span>
      </button>
      <Badge variant="outline" className="h-4 px-1 font-mono text-[9px] text-muted">
        {count}
      </Badge>
      {ticket && onOpenWorker && (
        <button
          type="button"
          onClick={onOpenWorker}
          className="ml-auto text-[10px] text-muted underline-offset-2 hover:text-accent hover:underline"
        >
          history →
        </button>
      )}
    </div>
  );
}

export function LiveTail({ rows, workers, onOpenWorker, focusFilter }: LiveTailProps) {
  const [filter, setFilter] = useState<TailFilter>(EMPTY_TAIL_FILTER);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  // Apply a cross-panel drill (P3 tool / P4 erroring-model) as a filter. Keyed on
  // the nonce so re-clicking the same value re-applies; resets the other axes so
  // the drill is an unambiguous "show me only this".
  const focusNonce = focusFilter?.nonce;
  useEffect(() => {
    if (!focusFilter) return;
    setFilter({
      ...EMPTY_TAIL_FILTER,
      tool: focusFilter.tool ?? "",
      eventType: focusFilter.eventType ?? "",
      errorsOnly: focusFilter.errorsOnly ?? false,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusNonce]);

  // PURE pipeline: bucket key → filter → group. Memoized on the inputs.
  const bucketKeyOf = useMemo(() => bucketKeyFactory(workers), [workers]);
  const filtered = useMemo(
    () => filterTailRows(rows, filter, bucketKeyOf),
    [rows, filter, bucketKeyOf],
  );
  const groups = useMemo(
    () => groupTailByWorker(filtered, workers),
    [filtered, workers],
  );

  // Worker chips list the attributed workers (sessionId → ticket·phase label).
  const workerChips = useMemo(
    () =>
      workers
        .filter((w) => w.sessionId)
        .map((w) => ({ key: w.sessionId!, label: `${w.ticket}·${w.phase}` })),
    [workers],
  );

  const toggleCollapsed = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      {/* Filter chips: worker · errors-only. Worker is a single-select toggle
          group; errors-only is a boolean chip. */}
      <div className="flex flex-wrap items-center gap-2">
        {workerChips.length > 0 && (
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            value={filter.worker}
            onValueChange={(v) =>
              setFilter((f) => ({ ...f, worker: v ?? "" }))
            }
            aria-label="Filter by worker"
          >
            {workerChips.map((c) => (
              <ToggleGroupItem
                key={c.key}
                value={c.key}
                className="font-mono text-[10px]"
              >
                {c.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        )}
        <button
          type="button"
          onClick={() =>
            setFilter((f) => ({ ...f, errorsOnly: !f.errorsOnly }))
          }
          aria-pressed={filter.errorsOnly}
          className={cn(
            "rounded-md border px-2 py-0.5 text-[10px] font-medium transition-colors",
            filter.errorsOnly
              ? "border-red/40 bg-red/10 text-red"
              : "border-border text-muted hover:text-fg",
          )}
        >
          errors only
        </button>
        <span className="ml-auto font-mono text-[10px] text-muted/70 tabular-nums">
          {filtered.length} {filtered.length === 1 ? "event" : "events"}
        </span>
      </div>

      {/* The tail itself — internally scrolled so the panel is height-capped and
          the hero stays the first paint (layout spec §5 #4). */}
      <ScrollArea className="min-h-0 flex-1 rounded-md border border-border bg-surface-2">
        {groups.length === 0 ? (
          <div className="px-3 py-6 text-center text-[11px] text-muted">
            no events match the current filter
          </div>
        ) : (
          groups.map((g) => {
            const open = !collapsed.has(g.key);
            const drill =
              g.key !== UNATTRIBUTED_KEY && g.workerName && onOpenWorker
                ? () => onOpenWorker(g.workerName!)
                : undefined;
            return (
              <div key={g.key}>
                <WorkerGroupHeader
                  label={g.label}
                  count={g.rows.length}
                  open={open}
                  ticket={g.ticket}
                  onToggle={() => toggleCollapsed(g.key)}
                  onOpenWorker={drill}
                />
                {open &&
                  g.rows.map((row, i) => (
                    <TailRowLine key={`${g.key}-${row.ts}-${i}`} row={row} />
                  ))}
              </div>
            );
          })
        )}
      </ScrollArea>
    </div>
  );
}
