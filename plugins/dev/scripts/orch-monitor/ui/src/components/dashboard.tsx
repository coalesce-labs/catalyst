import { useState } from "react";
import { fmtDuration, fmtCost, fmtSince } from "@/lib/formatters";
import { computeOrchestratorStats } from "@/lib/computations";
import { partitionDashboard } from "@/lib/partition-dashboard";
import { cn } from "@/lib/utils";
import { StatusBadge } from "./ui/badge";
import { StatusDot, HealthIcon } from "./ui/status-dot";
import { ProgressBar } from "./ui/progress-bar";
import { Panel, PanelHeader, SectionLabel } from "./ui/panel";
import { EmptyState } from "./ui/empty-state";
import { PrBadge } from "./ui/pr-badge";
import { KpiStrip } from "./kpi-strip";
import { AttentionBar } from "./attention-bar";
import { EventLog } from "./event-log";
import { ToolUsagePanel } from "./tool-usage-panel";
import { ApiErrorsPanel } from "./api-errors-panel";
import type {
  OrchestratorState,
  SessionTimeFilter,
  WorkerAnalytics,
  CollectedAttention,
  EventEntry,
  SessionState,
  SessionKind,
  OtelLogEntry,
} from "@/lib/types";
import { sessionKind } from "@/lib/types";
import {
  AlertCircle,
  ChevronRight,
  ChevronDown,
  Clock,
  Layers,
  Rocket,
  Terminal,
  GitBranch,
  Workflow,
} from "lucide-react";

interface DashboardProps {
  orchestrators: OrchestratorState[];
  sessions: SessionState[];
  attention: CollectedAttention[];
  events: EventEntry[];
  getAnalytics: (orchId: string) => Record<string, WorkerAnalytics | null>;
  onSelectOrch: (orchId: string) => void;
  selectedSessionId?: string | null;
  onSessionSelect?: (sessionId: string) => void;
  timeFilter: SessionTimeFilter;
  otelConfigured: boolean;
  otelTools: Record<string, number> | null;
  otelErrors: OtelLogEntry[] | null;
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

      {(orch.waves.length > 0 || orch.rollupBriefing) && (
        <div className="flex flex-wrap items-center gap-1.5">
          {orch.waves.map((w) => (
            <StatusBadge key={w.wave} status={w.status} />
          ))}
          {orch.rollupBriefing && (
            <span className="rounded bg-surface-3 px-1.5 py-px font-mono text-[10px] text-muted">
              rollup
            </span>
          )}
        </div>
      )}
    </button>
  );
}

const KIND_ICON: Record<SessionKind, React.ReactNode> = {
  orchestrator: <Workflow className="h-3.5 w-3.5 text-accent" />,
  worker: <Terminal className="h-3.5 w-3.5 text-green" />,
  standalone: <Terminal className="h-3.5 w-3.5 text-muted" />,
};

const KIND_LABEL: Record<SessionKind, string> = {
  orchestrator: "orchestrator",
  worker: "worker",
  standalone: "standalone",
};

function SessionCard({
  session,
  isSelected,
  onClick,
}: {
  session: SessionState;
  isSelected?: boolean;
  onClick?: () => void;
}) {
  const kind = sessionKind(session);
  const elapsed = session.startedAt
    ? (Date.now() - Date.parse(session.startedAt)) / 1000
    : 0;
  const isDone = session.status === "done" || session.status === "failed";
  const dir = session.cwd ? session.cwd.split("/").slice(-2).join("/") : null;

  return (
    <button
      onClick={onClick}
      className={cn(
        "flex flex-col gap-2 rounded-lg border bg-surface-2 p-4 text-left transition-all hover:border-accent/40 hover:bg-surface-3",
        isSelected ? "border-accent/60 bg-surface-3" : "border-border",
        isDone && !isSelected && "opacity-70",
      )}
    >
      <div className="flex items-start justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <StatusDot alive={session.alive} />
            <span className="truncate font-mono text-[14px] font-semibold text-fg">
              {session.label || session.sessionId}
            </span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-muted">
            <span className="flex items-center gap-1">
              {KIND_ICON[kind]}
              {KIND_LABEL[kind]}
            </span>
            {session.skillName && session.skillName !== "interactive" && (
              <span className="rounded bg-surface-3 px-1.5 py-px font-mono">
                {session.skillName}
              </span>
            )}
            {elapsed > 0 && (
              <span className="flex items-center gap-1">
                <Clock className="h-3 w-3" /> {fmtSince(elapsed)}
              </span>
            )}
          </div>
        </div>
        <StatusBadge status={session.status} />
      </div>

      <div className="flex flex-wrap items-center gap-3 text-[11px] text-muted">
        {session.ticket && (
          <span className="font-mono font-semibold text-fg">{session.ticket}</span>
        )}
        {session.pr && (
          <PrBadge
            number={session.pr.number}
            url={session.pr.url}
            state={session.pr.state ?? (session.pr.mergedAt ? "MERGED" : "OPEN")}
            mergeStateStatus={session.pr.mergeStateStatus}
            isDraft={session.pr.isDraft}
            mergedAt={session.pr.mergedAt}
            compact
          />
        )}
        {session.gitBranch && (
          <span className="flex items-center gap-1">
            <GitBranch className="h-3 w-3" />
            <span className="truncate max-w-[180px]">{session.gitBranch}</span>
          </span>
        )}
        {dir && (
          <span className="truncate font-mono opacity-60" title={session.cwd || ""}>
            {dir}
          </span>
        )}
        {session.cost && session.cost.costUSD > 0 && (
          <span className="ml-auto font-mono tabular-nums">
            {fmtCost(session.cost.costUSD)}
          </span>
        )}
      </div>
    </button>
  );
}

export function Dashboard({
  orchestrators,
  sessions,
  attention,
  events,
  getAnalytics,
  onSelectOrch,
  selectedSessionId,
  onSessionSelect,
  timeFilter,
  otelConfigured,
  otelTools,
  otelErrors,
}: DashboardProps) {
  const { needsMe, shipping, recent } = partitionDashboard({
    orchestrators,
    attention,
    timeFilter,
  });
  const [recentExpanded, setRecentExpanded] = useState(false);

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-lg font-bold text-fg">Dashboard</h1>

      <KpiStrip orchestrators={orchestrators} getAnalytics={getAnalytics} />

      {otelConfigured && (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <ToolUsagePanel tools={otelTools} configured={otelConfigured} />
          <ApiErrorsPanel errors={otelErrors} configured={otelConfigured} />
        </div>
      )}

      {needsMe.length > 0 && (
        <section aria-labelledby="zone-needs-me-heading">
          <h2
            id="zone-needs-me-heading"
            className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted"
          >
            <AlertCircle
              aria-hidden="true"
              className="h-3.5 w-3.5 text-red"
            />
            Needs me ({needsMe.length})
          </h2>
          <AttentionBar items={needsMe} />
        </section>
      )}

      <section aria-labelledby="zone-shipping-heading">
        <h2
          id="zone-shipping-heading"
          className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted"
        >
          <Rocket aria-hidden="true" className="h-3.5 w-3.5 text-accent" />
          Shipping ({shipping.length})
        </h2>
        {shipping.length > 0 ? (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {shipping.map((o) => (
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
      </section>

      {recent.length > 0 && (
        <section aria-labelledby="zone-recent-heading">
          <h2 id="zone-recent-heading" className="text-[11px] font-semibold uppercase tracking-wider">
            <button
              onClick={() => setRecentExpanded((e) => !e)}
              className="flex items-center gap-1.5 px-1 py-1 font-semibold uppercase tracking-wider text-muted transition-colors hover:text-fg"
              aria-expanded={recentExpanded}
              aria-controls="zone-recent-panel"
              aria-label={`${recentExpanded ? "Hide" : "Show"} Recent orchestrators (${recent.length})`}
            >
              {recentExpanded ? (
                <ChevronDown aria-hidden="true" className="h-3.5 w-3.5" />
              ) : (
                <ChevronRight aria-hidden="true" className="h-3.5 w-3.5" />
              )}
              <span>
                {recentExpanded ? "Hide" : "Show"} Recent ({recent.length})
              </span>
            </button>
          </h2>
          {recentExpanded && (
            <div
              id="zone-recent-panel"
              className="mt-2 grid gap-3 opacity-60 sm:grid-cols-2 xl:grid-cols-3"
            >
              {recent.map((o) => (
                <OrchestratorCard
                  key={o.id}
                  orch={o}
                  getAnalytics={getAnalytics}
                  onClick={() => onSelectOrch(o.id)}
                />
              ))}
            </div>
          )}
        </section>
      )}

      {sessions.length > 0 && (
        <div>
          <SectionLabel className="mb-2 block">
            Sessions ({sessions.length})
          </SectionLabel>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {sessions.map((s) => (
              <SessionCard
                key={s.sessionId}
                session={s}
                isSelected={selectedSessionId === s.sessionId}
                onClick={() => onSessionSelect?.(s.sessionId)}
              />
            ))}
          </div>
        </div>
      )}

      <Panel>
        <PanelHeader>
          <SectionLabel>Events</SectionLabel>
        </PanelHeader>
        <EventLog events={events} />
      </Panel>
    </div>
  );
}
