import { fmtDuration, fmtCost } from "@/lib/formatters";
import { computeOrchestratorStats } from "@/lib/computations";
import { SectionLabel } from "./ui/panel";
import type { OrchestratorState, WorkerAnalytics } from "@/lib/types";
import { DollarSign } from "lucide-react";

interface CostCardProps {
  orch: OrchestratorState;
  getAnalytics: (orchId: string) => Record<string, WorkerAnalytics | null>;
}

export function CostCard({ orch, getAnalytics }: CostCardProps) {
  const s = computeOrchestratorStats(orch, getAnalytics(orch.id));

  return (
    <div className="flex flex-wrap items-baseline gap-4 border-t border-border px-4 py-3">
      <div className="flex items-center gap-2">
        <DollarSign className="h-4 w-4 text-muted" />
        {s.totalCost > 0 ? (
          <span className="font-mono text-xl font-bold text-fg tabular-nums">
            {fmtCost(s.totalCost)}
          </span>
        ) : (
          <span className="text-[13px] italic text-muted">No cost data yet</span>
        )}
      </div>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[12px] text-muted">
        <span>
          {s.total} worker{s.total !== 1 ? "s" : ""} ({s.done} done)
        </span>
        {s.wallMs > 0 && <span>{fmtDuration(s.wallMs)} wall clock</span>}
        {s.parallelism > 0 && (
          <span
            className="cursor-help border-b border-dotted border-muted"
            title="Sum of per-worker compute time ÷ wall clock. >1× means parallelism saved time."
          >
            {s.parallelism.toFixed(1)}× parallel efficiency
          </span>
        )}
      </div>
      {s.parallelism > 0 && (
        <span className="w-full font-mono text-[11px] text-muted">
          Σ compute {fmtDuration(s.totalDurationMs)} · wall{" "}
          {fmtDuration(s.wallMs)}
        </span>
      )}
    </div>
  );
}
