// error-clusters-panel.tsx — the TELEMETRY P2 panel body (OBS-7): API errors
// clustered by (error string + model), ranked loudest-first, each row a horizontal
// count bar. A click opens a drill-down modal with the request_id / session /
// ticket of the cluster's representative (newest) line.
//
// A metric-row "bar-horizontal" (Principle 9/10), NOT a Recharts chart — the bar is
// a CSS-width div. The error count uses the health red token (Principle 3 — these
// ARE faults, so red is semantic here), not a categorical chart color.
//
// The 24h rate trend is a `Sparkline` (60×32, no axes) rendered in the card HEADER
// by the caller — NOT a full chart and NOT inside a row (layout spec §5 violation
// #2). This component is the row body only; the ChartCard owns the
// unconfigured / unreachable / empty honesty states (an empty error set — the
// common, healthy case right now — is the card's "no data in range").

import { useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { OtelLogEntry } from "@/lib/types";
import {
  clusterApiErrors,
  barPercent,
  compactCount,
  type ErrorCluster,
} from "./telemetry-panels";

export interface ErrorClustersPanelProps {
  /** Raw api_error log entries (from /api/otel/errors?range=1h). */
  entries: OtelLogEntry[];
}

/** One field row inside the drill modal — dim when absent (never fabricated). */
function ModalField({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1 text-[12px]">
      <span className="text-muted">{label}</span>
      {value ? (
        <span className="font-mono text-fg">{value}</span>
      ) : (
        <span className="font-mono text-muted/40">—</span>
      )}
    </div>
  );
}

function ClusterRow({
  cluster,
  maxCount,
  onOpen,
}: {
  cluster: ErrorCluster;
  maxCount: number;
  onOpen: () => void;
}) {
  const width = barPercent(cluster.count, maxCount);
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        "group flex w-full items-center gap-3 px-3 py-1.5 text-left",
        "border-b border-border/40 last:border-b-0 hover:bg-surface-1",
      )}
    >
      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-fg group-hover:text-accent">
        {cluster.error}
      </span>
      <span className="w-16 shrink-0 truncate text-right font-mono text-[10px] text-muted">
        {cluster.model}
      </span>
      <span className="relative h-2.5 w-20 shrink-0 overflow-hidden rounded-sm bg-surface-3">
        <span
          className="absolute inset-y-0 left-0 rounded-sm bg-red/70"
          style={{ width: `${width}%` }}
        />
      </span>
      <span className="w-8 shrink-0 text-right font-mono text-[11px] tabular-nums text-red">
        {compactCount(cluster.count)}
      </span>
    </button>
  );
}

export function ErrorClustersPanel({ entries }: ErrorClustersPanelProps) {
  const clusters = useMemo(() => clusterApiErrors(entries), [entries]);
  const maxCount = useMemo(
    () => clusters.reduce((m, c) => (c.count > m ? c.count : m), 0),
    [clusters],
  );
  const [open, setOpen] = useState<ErrorCluster | null>(null);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ScrollArea className="min-h-0 flex-1 rounded-md border border-border bg-surface-2">
        {clusters.map((c) => (
          <ClusterRow
            key={`${c.error} ${c.model}`}
            cluster={c}
            maxCount={maxCount}
            onOpen={() => setOpen(c)}
          />
        ))}
      </ScrollArea>

      {/* Drill: error row → full-label request modal (request_id, session, ticket). */}
      <Dialog open={open !== null} onOpenChange={(o) => !o && setOpen(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="font-mono text-sm">
              {open?.error}
            </DialogTitle>
          </DialogHeader>
          {open && (
            <div className="flex flex-col divide-y divide-border/50">
              <ModalField label="model" value={open.model} />
              <ModalField label="occurrences" value={String(open.count)} />
              <ModalField label="last seen" value={open.lastSeen} />
              <ModalField label="request_id" value={open.requestId} />
              <ModalField label="session" value={open.sessionId} />
              <ModalField label="ticket" value={open.linearKey} />
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
