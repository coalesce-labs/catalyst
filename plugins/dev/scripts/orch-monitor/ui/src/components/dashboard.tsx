import { fmtDuration, fmtCost } from "@/lib/formatters";
import { computeOrchestratorStats } from "@/lib/computations";
import { StatusBadge } from "./ui/badge";
import { HealthIcon } from "./ui/status-dot";
import { ProgressBar } from "./ui/progress-bar";
import { Panel, PanelHeader, SectionLabel } from "./ui/panel";
import { EmptyState } from "./ui/empty-state";
import { KpiStrip } from "./kpi-strip";
import { AttentionBar } from "./attention-bar";
import { EventLog } from "./event-log";
import type {
  OrchestratorState,
  WorkerAnalytics,
  CollectedAttention,
  EventEntry,
} from "@/lib/types";
import { ChevronRight, Clock, Layers } from "lucide-react";

interface DashboardProps {
  orchestrators: OrchestratorState[];
  attention: CollectedAttention[];
  events: EventEntry[];
  getAnalytics: (orchId: string) => Record<string, WorkerAnalytics | null>;
  onSelectOrch: (orchId: string) => void;
}

function OrchestratorCard({
  orch,
  getAnalytics,
  onClick,
}: {
  orch: OrchestratorState;
  getAnalytics: (orchId: string) => Record<string, WorkerAnalytics | null>;
  onClick: () => void;
}) {
  const s = computeOrchestratorStats(orch, getAnalytics(orch.id));
  const startMs = orch.startedAt ? Date.parse(orch.startedAt) : NaN;
  const wallMs = Number.isFinite(startMs) ? Date.now() - startMs : 0;

  return (
    <button
      onClick={onClick}
      className="group flex flex-col gap-3 rounded-lg border border-border bg-surface-2 p-4 text-left transition-all hover:border-accent/40 hover:bg-surface-3"
    >
      <div className="flex items-start justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <HealthIcon failed={s.failed} active={s.active} />
            <span className="truncate font-mono text-[14px] font-semibold text-fg">
              {orch.id}
            </span>
          </div>
          <div className="mt-1 flex items-center gap-3 text-[12px] text-muted">
            <span>
              Wave {orch.currentWave}/{orch.totalWaves}
            </span>
            {wallMs > 0 && (
              <span className="flex items-center gap-1">
                <Clock className="h-3 w-3" /> {fmtDuration(wallMs)}
              </span>
            )}
          </div>
        </div>
        <ChevronRight className="h-4 w-4 flex-shrink-0 text-border transition-colors group-hover:text-accent" />
      </div>

      <ProgressBar pct={s.pct} trackClass="bg-surface-4" />

      <div className="flex items-center gap-4 text-[12px]">
        <span className="text-fg">
          {s.done}/{s.total} merged ({s.pct}%)
        </span>
        {s.active > 0 && (
          <span className="flex items-center gap-1 text-green">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-green" />
            {s.active} active
          </span>
        )}
        {s.failed > 0 && <span className="text-red">{s.failed} failed</span>}
        {s.totalCost > 0 && (
          <span className="ml-auto font-mono text-muted tabular-nums">
            {fmtCost(s.totalCost)}
          </span>
        )}
      </div>

      {orch.waves.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {orch.waves.map((w) => (
            <StatusBadge key={w.wave} status={w.status} />
          ))}
        </div>
      )}
    </button>
  );
}

export function Dashboard({
  orchestrators,
  attention,
  events,
  getAnalytics,
  onSelectOrch,
}: DashboardProps) {
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-lg font-bold text-fg">Dashboard</h1>

      <AttentionBar items={attention} />

      <KpiStrip orchestrators={orchestrators} getAnalytics={getAnalytics} />

      <div>
        <SectionLabel className="mb-2 block">
          Orchestrators ({orchestrators.length})
        </SectionLabel>
        {orchestrators.length > 0 ? (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {orchestrators.map((o) => (
              <OrchestratorCard
                key={o.id}
                orch={o}
                getAnalytics={getAnalytics}
                onClick={() => onSelectOrch(o.id)}
              />
            ))}
          </div>
        ) : (
          <EmptyState icon={Layers} message="No active orchestrators found" />
        )}
      </div>

      <Panel>
        <PanelHeader>
          <SectionLabel>Events</SectionLabel>
        </PanelHeader>
        <EventLog events={events} />
      </Panel>
    </div>
  );
}
