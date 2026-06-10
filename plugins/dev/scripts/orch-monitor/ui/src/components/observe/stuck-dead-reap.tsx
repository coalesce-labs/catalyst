// stuck-dead-reap.tsx — the FLEETOPS P2 action panel (OBS-18, layout spec §5).
// THE FIRST-SCREEN action: the stuck/dead worker list with the literal
// `claude stop <shortId>` command INLINE per row (NOT behind a drill-down). The
// reap path is historically broken (memory #11), so surfacing the command IS the
// observability. When 0 stuck/dead, the honest "no stuck or dead workers" empty
// state — 0 dead is the GOOD state, rendered calmly, never as a problem.
//
// A board-backed ChartCard (dataSource="[board+events]", health={null}): board
// panels never gate on OTEL health (chart-card.tsx:124), so it only goes empty or
// live. This is part of what makes FleetOps survive a telemetry-stack outage.

import { useState } from "react";
import { Copy, Check } from "lucide-react";
import { ChartCard } from "@/components/observe/chart-card";
import { fmtRelativeDuration } from "@/lib/formatters";
import type { ReapRow } from "./fleetops-kit";

/** The FleetOps-specific calm empty copy — 0 stuck/dead is the GOOD state, so it
 *  reads better than ChartCard's generic "no data in range" (layout spec §5). */
export const REAP_EMPTY_COPY = "no stuck or dead workers — reap path clear";

/** The state-badge tone per reap reason — red for dead/stuck (needs intervention),
 *  amber for silent (a softer stall signal). Status colors only (Principle 3). */
const REASON_VAR: Record<ReapRow["reason"], string> = {
  dead: "var(--chart-4)",
  stuck: "var(--chart-4)",
  silent: "var(--chart-3)",
};

const REASON_LABEL: Record<ReapRow["reason"], string> = {
  dead: "dead",
  stuck: "stuck",
  silent: "silent",
};

/** Copy-to-clipboard button for a reap command. Shows a transient check on copy. */
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label="Copy reap command"
      title="Copy command"
      onClick={(e) => {
        e.stopPropagation();
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
      className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted hover:bg-surface-3 hover:text-fg"
    >
      {copied ? (
        <Check className="h-3 w-3" style={{ color: "var(--chart-2)" }} />
      ) : (
        <Copy className="h-3 w-3" />
      )}
    </button>
  );
}

export interface StuckDeadReapProps {
  /** The derived reap rows (reapList output). [] → the honest empty state. */
  rows: readonly ReapRow[];
  className?: string;
}

export function StuckDeadReap({ rows, className }: StuckDeadReapProps) {
  // hasData is held TRUE so the card stays "live" and renders OUR FleetOps-specific
  // empty copy below — not ChartCard's generic "no data in range". 0 dead is the
  // GOOD state and reads calmer with bespoke copy (layout spec §5).
  const empty = rows.length === 0;
  return (
    <ChartCard
      title="Stuck / dead workers"
      dataSource="[board+events]"
      health={null}
      hasData
      className={className}
      bodyClassName="min-h-[180px] p-2"
    >
      {empty ? (
        <div className="flex h-full flex-col items-center justify-center gap-1 text-center">
          <span
            className="text-[13px] font-medium"
            style={{ color: "var(--chart-2)" }}
          >
            {REAP_EMPTY_COPY}
          </span>
          <span className="text-[11px] text-muted">
            nothing to reap — every worker is healthy
          </span>
        </div>
      ) : (
      <div className="flex h-full flex-col overflow-y-auto">
        <div className="grid grid-cols-[1fr_auto_auto_auto] gap-x-3 border-b border-border/40 px-1 pb-1 text-[10px] font-medium uppercase tracking-wide text-muted/70">
          <span>Ticket · phase</span>
          <span>State</span>
          <span className="text-right">Idle</span>
          <span className="text-right">Host</span>
        </div>
        {rows.map((r) => (
          <div
            key={r.name}
            className="border-b border-border/20 py-1.5"
          >
            <button
              type="button"
              onClick={() => window.location.assign(`/worker/${encodeURIComponent(r.name)}`)}
              className="grid w-full grid-cols-[1fr_auto_auto_auto] items-center gap-x-3 px-1 text-left text-[12px] tabular-nums hover:bg-surface-2"
            >
              <span className="truncate">
                <span className="font-mono">{r.ticket}</span>
                <span className="text-muted/70"> · {r.phase}</span>
              </span>
              <span
                className="rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
                style={{ color: REASON_VAR[r.reason], backgroundColor: `color-mix(in srgb, ${REASON_VAR[r.reason]} 14%, transparent)` }}
              >
                {REASON_LABEL[r.reason]}
              </span>
              <span className="text-right text-muted">
                {fmtRelativeDuration(r.lastActiveMs) ?? "—"}
              </span>
              <span className="truncate text-right font-mono text-muted">
                {r.host ?? "—"}
              </span>
            </button>
            {/* The INLINE reap hint — the literal `claude stop <shortId>` command,
                on-screen per row (NOT a drill-down). Copy-able. When no honest
                shortId exists, omit the command rather than fabricate a target. */}
            {r.reapCommand ? (
              <div className="mt-1 flex items-center gap-1.5 pl-3 font-mono text-[11px] text-muted">
                <span className="text-muted/60">└</span>
                <span className="select-all text-fg/80">{r.reapCommand}</span>
                <CopyButton text={r.reapCommand} />
              </div>
            ) : (
              <div className="mt-1 pl-3 text-[11px] text-muted/60">
                └ no session id — reap manually via the worker page
              </div>
            )}
          </div>
        ))}
      </div>
      )}
    </ChartCard>
  );
}
