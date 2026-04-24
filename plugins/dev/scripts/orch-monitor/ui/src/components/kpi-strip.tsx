import { fmtDuration, fmtCost } from "@/lib/formatters";
import { computeOrchestratorStats, type OrchestratorStats } from "@/lib/computations";
import { MetricCard } from "./ui/panel";
import { useAnimatedNumber } from "@/hooks/use-animated-number";
import type { OrchestratorState, WorkerAnalytics } from "@/lib/types";
import { CheckCircle2, Users, DollarSign, Clock } from "lucide-react";

interface KpiStripProps {
  orchestrators: OrchestratorState[];
  getAnalytics: (orchId: string) => Record<string, WorkerAnalytics | null>;
}

function aggregateStats(
  orchestrators: OrchestratorState[],
  getAnalytics: (id: string) => Record<string, WorkerAnalytics | null>,
): OrchestratorStats {
  let total = 0,
    done = 0,
    failed = 0,
    abandoned = 0,
    active = 0,
    totalCost = 0,
    wallMs = 0,
    totalDurationMs = 0;
  let minStartMs = Infinity;
  let maxEndMs = -Infinity;

  for (const o of orchestrators) {
    const s = computeOrchestratorStats(o, getAnalytics(o.id));
    total += s.total;
    done += s.done;
    failed += s.failed;
    abandoned += s.abandoned;
    active += s.active;
    totalCost += s.totalCost;
    totalDurationMs += s.totalDurationMs;
    if (s.minStartMs && s.minStartMs < minStartMs) minStartMs = s.minStartMs;
    if (s.maxEndMs && s.maxEndMs > maxEndMs) maxEndMs = s.maxEndMs;
  }

  const effectiveEnd = maxEndMs === -Infinity ? Date.now() : maxEndMs;
  wallMs =
    Number.isFinite(minStartMs) && effectiveEnd > minStartMs
      ? effectiveEnd - minStartMs
      : 0;
  const parallelism =
    wallMs > 0 && totalDurationMs > 0 ? totalDurationMs / wallMs : 0;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  return {
    total,
    done,
    failed,
    abandoned,
    active,
    pct,
    totalCost,
    wallMs,
    totalDurationMs,
    parallelism,
    minStartMs: Number.isFinite(minStartMs) ? minStartMs : 0,
    maxEndMs: Number.isFinite(maxEndMs) ? maxEndMs : 0,
  };
}

export function KpiStrip({ orchestrators, getAnalytics }: KpiStripProps) {
  const s = aggregateStats(orchestrators, getAnalytics);
  const animPct = useAnimatedNumber(s.pct);
  const animActive = useAnimatedNumber(s.active);
  const animCost = useAnimatedNumber(s.totalCost);

  return (
    <div
      className="grid grid-cols-2 gap-3 border-t-2 pt-3 lg:grid-cols-4"
      style={{ borderTopColor: "var(--project-color)" }}
    >
      <MetricCard
        label="Completion"
        value={`${Math.round(animPct)}%`}
        sub={`${s.done}/${s.total} workers`}
        icon={<CheckCircle2 className="h-4 w-4" />}
        color="text-green"
      />
      <MetricCard
        label="Active"
        value={String(Math.round(animActive))}
        sub={s.failed > 0 ? `${s.failed} failed` : "workers running"}
        icon={<Users className="h-4 w-4" />}
        color={s.failed > 0 ? "text-red" : "text-blue"}
      />
      <MetricCard
        label="Total Cost"
        value={animCost > 0.01 ? fmtCost(animCost) : "—"}
        sub={
          s.total > 0 && s.totalCost > 0
            ? `~${fmtCost(s.totalCost / s.total)}/worker`
            : undefined
        }
        icon={<DollarSign className="h-4 w-4" />}
        color="text-yellow"
      />
      <MetricCard
        label="Wall Clock"
        value={s.wallMs > 0 ? fmtDuration(s.wallMs) : "—"}
        sub={
          orchestrators.length > 1
            ? `${orchestrators.length} orchestrators`
            : undefined
        }
        icon={<Clock className="h-4 w-4" />}
        color="text-accent"
      />
    </div>
  );
}
