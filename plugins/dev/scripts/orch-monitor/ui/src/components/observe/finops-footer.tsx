// finops-footer.tsx — the FINOPS footer strip (OBS-11, layout spec §2 footer):
// a single dense row of data-trust read-outs, NOT panels (counts toward density,
// not the ≤8 element budget — it reads as one strip).
//
//   A4 Concentration — "top 3 tickets = N% of spend" (topk share over /api/otel/cost).
//   A8 Cost-validation drift — the worst signal-file-vs-OTEL Δ$ (/api/otel/cost-
//      validation). A data-trust footer: best-in-class dashboards surface their own
//      measurement error.
//   $/story-point — DEFERRED (locked): needs OBS-12 estimate write-through. Rendered
//      as a dimmed, dashed, plain-language locked chip occupying its real footprint —
//      NEVER a blank or a fabricated number (Principle 6).
//
// HONESTY: every number flows through the pure helpers (concentration / worstDrift),
// each of which returns an honest "—" / null on empty input — no fabricated $0 that
// would falsely claim "no concentration" or "perfect signal agreement".

import { useMemo } from "react";
import { cn } from "@/lib/utils";
import { Lock } from "lucide-react";
import { compactUsd, formatUsd } from "./finops-panels";
import {
  rankCostMap,
  concentration,
  worstDrift,
} from "./finops-breakdowns";
import type { CostValidationRow } from "@/lib/types";

export interface FinopsFooterProps {
  /** /api/otel/cost map — the A4 concentration source. */
  cost: Record<string, number> | null;
  /** /api/otel/cost-validation rows — the A8 drift source. */
  validation: CostValidationRow[] | null;
}

function FooterCell({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-0.5", className)}>
      <span className="text-[9px] font-medium uppercase tracking-wide text-muted/60">
        {label}
      </span>
      <span className="truncate font-mono text-[12px] tabular-nums text-fg">
        {children}
      </span>
    </div>
  );
}

export function FinopsFooter({ cost, validation }: FinopsFooterProps) {
  const conc = useMemo(() => concentration(rankCostMap(cost), 3), [cost]);
  const drift = useMemo(() => worstDrift(validation), [validation]);

  const concText =
    conc.count > 0
      ? `top ${conc.count} = ${Math.round(conc.share * 100)}% of ${compactUsd(conc.totalUsd)}`
      : "—";

  const driftText = drift
    ? `${drift.ticket} Δ${formatUsd(drift.discrepancy)}`
    : "—";

  return (
    <div className="flex flex-wrap items-stretch gap-x-8 gap-y-3 rounded-md border border-border bg-surface-1/40 px-4 py-2.5">
      <FooterCell label="A4 · concentration">{concText}</FooterCell>
      <FooterCell label="A8 · signal vs otel drift">{driftText}</FooterCell>

      {/* DEFERRED — $/story-point. A dimmed dashed locked chip (Principle 6). */}
      <div className="flex min-w-0 flex-col gap-0.5 rounded-sm border border-dashed border-border/60 px-2 py-1 opacity-60">
        <span className="flex items-center gap-1 text-[9px] font-medium uppercase tracking-wide text-muted/60">
          <Lock className="h-2.5 w-2.5" aria-hidden />
          $/story-point
        </span>
        <span className="truncate text-[11px] text-muted">
          needs estimate sync (OBS-12)
        </span>
      </div>
    </div>
  );
}
