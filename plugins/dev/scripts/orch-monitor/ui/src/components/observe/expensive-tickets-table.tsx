// expensive-tickets-table.tsx — the FINOPS P-C panel body (OBS-11, layout spec §2):
// the sortable expensive-tickets table. The DEFAULT FinOps view (Principle 10:
// table-driven by default; charts are the "explore" affordance).
//
// HONESTY (design §1/§2):
//   - The rows come from /api/otel/cost via rankCostMap, which applies the MANDATORY
//     zero-series filter at the data layer — a least-expensive sort can never render
//     the ~24 exact-0 tickets as all-zeros garbage.
//   - The $/point and $/PR columns are DEFERRED (need OBS-12 estimate write-through):
//     they render as DIMMED locked column headers with a "needs estimate sync"
//     tooltip + an em-dash cell — never a fabricated number, and never hidden (which
//     would shift the table width when OBS-12 lands).
//   - Each row carries a proportional magnitude bar (real data: the row's share of
//     the top spender) — NOT a fabricated time-series sparkline. /api/otel/cost
//     returns a scalar per ticket; inventing a per-row trend line would be dishonest.
//
// Row click → the ticket detail page (the CTL-918 telemetry strip) via the same
// `window.location.assign(ticketDetailHref(...))` idiom the telemetry surface uses
// for its worker drill.

import { useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { ArrowDown, ArrowUp, Lock } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ScrollArea } from "@/components/ui/scroll-area";
import { formatUsd } from "./finops-panels";
import { barPercent } from "./telemetry-panels";
import { rankCostMap, maxUsd, type CostRow } from "./finops-breakdowns";
import { ticketDetailHref } from "@/board/detail-nav";

type SortKey = "label" | "usd";
type SortDir = "asc" | "desc";

export interface ExpensiveTicketsTableProps {
  /** /api/otel/cost payload (linear_key → USD). Zero-filtered + ranked here. */
  data: Record<string, number> | null;
  /** Cap the rendered rows (default 10 — the layout spec's ranked-10). */
  limit?: number;
}

/** Sort the zero-filtered rows by the active key/dir. $ sort is the default
 *  (descending = most-expensive-first, the panel's question). */
function sortRows(rows: CostRow[], key: SortKey, dir: SortDir): CostRow[] {
  const sorted = [...rows].sort((a, b) => {
    if (key === "label") return a.label.localeCompare(b.label);
    return a.usd - b.usd;
  });
  return dir === "desc" ? sorted.reverse() : sorted;
}

/** The dimmed "needs estimate sync" locked column header (OBS-12). Renders the
 *  header text greyed with a lock + a tooltip explaining what unlocks it — never
 *  hidden (so the table width is stable when OBS-12 lands). */
function LockedHeader({ label }: { label: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex items-center gap-1 text-muted/50">
          <Lock className="h-2.5 w-2.5" aria-hidden />
          {label}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-[220px] text-[11px]">
        Needs estimate sync (OBS-12). $ per point + $ per merged PR appear once the
        estimate write-through lands — never imputed.
      </TooltipContent>
    </Tooltip>
  );
}

function SortHeader({
  label,
  active,
  dir,
  onClick,
  className,
}: {
  label: string;
  active: boolean;
  dir: SortDir;
  onClick: () => void;
  className?: string;
}) {
  const Icon = dir === "desc" ? ArrowDown : ArrowUp;
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1 font-medium hover:text-fg",
        active ? "text-fg" : "text-muted",
        className,
      )}
    >
      {label}
      {active && <Icon className="h-3 w-3" />}
    </button>
  );
}

export function ExpensiveTicketsTable({
  data,
  limit = 10,
}: ExpensiveTicketsTableProps) {
  const [sortKey, setSortKey] = useState<SortKey>("usd");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const ranked = useMemo(() => rankCostMap(data), [data]);
  const max = useMemo(() => maxUsd(ranked), [ranked]);
  const rows = useMemo(
    () => sortRows(ranked, sortKey, sortDir).slice(0, limit),
    [ranked, sortKey, sortDir, limit],
  );

  function toggle(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    } else {
      setSortKey(key);
      setSortDir(key === "usd" ? "desc" : "asc");
    }
  }

  // CTL-1033 component-surface standard: the table BODY sits on the PANEL surface
  // (card), not below it — was bg-surface-0 → darker than its panel header.
  return (
    <ScrollArea className="h-full min-h-0 rounded-md border border-border bg-surface-2">
      <Table className="text-[12px]">
        <TableHeader>
          <TableRow className="border-border/60 hover:bg-transparent">
            <TableHead className="h-9 px-3 py-0 text-[11px]">
              <SortHeader
                label="ticket"
                active={sortKey === "label"}
                dir={sortDir}
                onClick={() => toggle("label")}
              />
            </TableHead>
            <TableHead className="h-9 px-2 py-0 text-right text-[11px]">
              <SortHeader
                label="spend"
                active={sortKey === "usd"}
                dir={sortDir}
                onClick={() => toggle("usd")}
                className="justify-end"
              />
            </TableHead>
            <TableHead className="h-9 w-[88px] px-2 py-0 text-[11px]">
              {/* proportional magnitude bar header (no sort) */}
              <span className="text-muted/60">share</span>
            </TableHead>
            <TableHead className="h-9 px-2 py-0 text-right text-[11px]">
              <LockedHeader label="$/pt" />
            </TableHead>
            <TableHead className="h-9 px-2 py-0 text-right text-[11px]">
              <LockedHeader label="$/PR" />
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow
              key={row.label}
              className="h-10 cursor-pointer border-border/40"
              onClick={() => window.location.assign(ticketDetailHref(row.label))}
            >
              <TableCell className="px-3 py-0 font-mono text-[12px] text-fg">
                {row.label}
              </TableCell>
              <TableCell className="px-2 py-0 text-right font-mono tabular-nums text-fg">
                {formatUsd(row.usd)}
              </TableCell>
              <TableCell className="px-2 py-0">
                <span className="relative block h-2 w-full overflow-hidden rounded-sm bg-surface-3">
                  <span
                    className="absolute inset-y-0 left-0 rounded-sm"
                    style={{
                      width: `${barPercent(row.usd, max)}%`,
                      backgroundColor: "var(--chart-1)",
                    }}
                  />
                </span>
              </TableCell>
              {/* DEFERRED — dimmed em-dash, never a fabricated number (OBS-12). */}
              <TableCell className="px-2 py-0 text-right font-mono text-muted/40">
                —
              </TableCell>
              <TableCell className="px-2 py-0 text-right font-mono text-muted/40">
                —
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </ScrollArea>
  );
}
