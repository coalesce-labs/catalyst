import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { computeOrchestratorStats } from "@/lib/computations";
import { hasAnyBriefings, hasRollup } from "@/lib/briefings";
import { ProgressBar } from "./ui/progress-bar";
import { Panel, SectionLabel } from "./ui/panel";
import type {
  OrchestratorState,
  WorkerState,
  WorkerAnalytics,
  LinearTicket,
  EventEntry,
  TabId,
  OtelHealth,
} from "@/lib/types";
import { KpiStrip } from "./kpi-strip";
import { WaveCards } from "./wave-cards";
import { CostCard } from "./cost-card";
import { WorkerTable } from "./worker-table";
import { WorkerDetailDrawer } from "./worker-detail-drawer";
import { GanttChart } from "./gantt-chart";
import { EventLog } from "./event-log";
import { BriefingTab } from "./briefing-tab";
import {
  LayoutGrid,
  Users,
  BarChart3,
  Activity,
  BookOpen,
} from "lucide-react";

interface OrchestratorViewProps {
  orch: OrchestratorState;
  events: EventEntry[];
  getAnalytics: (orchId: string) => Record<string, WorkerAnalytics | null>;
  getLinear: (ticket: string) => LinearTicket | null;
  staleThreshold: number;
  otelHealth?: OtelHealth | null;
  commsAuthors?: Set<string>;
  onCommsLink?: (ticket: string) => void;
  /**
   * Optional lifted state for the worker drawer. When provided, parent owns
   * `selectedWorker` (e.g. so the Activity pane can pivot directly to a
   * worker). When omitted, the component falls back to local state.
   */
  selectedWorker?: string | null;
  onWorkerSelect?: (ticket: string | null) => void;
}

const TABS: { id: TabId; label: string; icon: React.ReactNode }[] = [
  {
    id: "overview",
    label: "Overview",
    icon: <LayoutGrid className="h-3.5 w-3.5" />,
  },
  {
    id: "workers",
    label: "Workers",
    icon: <Users className="h-3.5 w-3.5" />,
  },
  {
    id: "timeline",
    label: "Timeline",
    icon: <BarChart3 className="h-3.5 w-3.5" />,
  },
  {
    id: "events",
    label: "Events",
    icon: <Activity className="h-3.5 w-3.5" />,
  },
  {
    id: "briefing",
    label: "Briefing",
    icon: <BookOpen className="h-3.5 w-3.5" />,
  },
];

export function OrchestratorView({
  orch,
  events,
  getAnalytics,
  getLinear,
  staleThreshold,
  otelHealth,
  commsAuthors,
  onCommsLink,
  selectedWorker: selectedWorkerProp,
  onWorkerSelect,
}: OrchestratorViewProps) {
  const [activeTab, setActiveTab] = useState<TabId>("overview");
  const [selectedWave, setSelectedWave] = useState<number | null>(null);
  // Either parent owns the selection (lifted state) or we own it locally.
  const [internalSelectedWorker, setInternalSelectedWorker] = useState<
    string | null
  >(null);
  const selectedWorker = selectedWorkerProp ?? internalSelectedWorker;
  const setSelectedWorker = onWorkerSelect ?? setInternalSelectedWorker;

  const selectedW: WorkerState | null =
    selectedWorker ? (orch.workers[selectedWorker] ?? null) : null;

  const s = computeOrchestratorStats(orch, getAnalytics(orch.id));
  const showBriefing = hasAnyBriefings(orch) || hasRollup(orch);
  const visibleTabs = TABS.filter(
    (t) => t.id !== "briefing" || showBriefing,
  );

  // Guard: if the briefing tab was active and briefings disappear (e.g. an
  // orchestrator's data rolls over), snap back to overview.
  useEffect(() => {
    if (activeTab === "briefing" && !showBriefing) {
      setActiveTab("overview");
    }
  }, [activeTab, showBriefing]);

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <div>
        <h1 className="font-mono text-lg font-bold text-fg">{orch.id}</h1>
        <div className="mt-1 flex items-center gap-4 text-[12px] text-muted">
          <span>
            Wave {orch.currentWave}/{orch.totalWaves}
          </span>
          <span>
            {s.done}/{s.total} merged ({s.pct}%)
          </span>
          {orch.startedAt && (
            <span>Started {new Date(orch.startedAt).toLocaleString()}</span>
          )}
        </div>
        <ProgressBar pct={s.pct} className="mt-2 max-w-md" />
      </div>

      {/* KPI strip */}
      <KpiStrip orchestrators={[orch]} getAnalytics={getAnalytics} />

      {/* Tabs */}
      <div className="border-b border-border">
        <div className="flex gap-0">
          {visibleTabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={cn(
                "flex items-center gap-1.5 border-b-2 px-4 py-2 text-[13px] font-medium transition-colors",
                activeTab === tab.id
                  ? "border-accent text-fg"
                  : "border-transparent text-muted hover:border-border hover:text-fg",
              )}
            >
              {tab.icon}
              {tab.label}
              {tab.id === "workers" && (
                <span className="ml-1 rounded-full bg-surface-3 px-1.5 py-px text-[10px] text-muted">
                  {s.total}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Tab content */}
      <Panel>
        {activeTab === "overview" && (
          <div key="overview" className="animate-fade-in-fast">
            <WaveCards
              orch={orch}
              onWaveSelect={setSelectedWave}
              selectedWave={selectedWave}
            />
            <CostCard orch={orch} getAnalytics={getAnalytics} />
            <div className="border-t border-border">
              <div className="px-4 py-2">
                <SectionLabel>
                  Workers{" "}
                  {selectedWave != null ? `· Wave ${selectedWave}` : ""}
                </SectionLabel>
              </div>
              <WorkerTable
                orch={orch}
                getAnalytics={getAnalytics}
                getLinear={getLinear}
                staleThreshold={staleThreshold}
                filterWave={selectedWave}
                onWorkerSelect={setSelectedWorker}
                selectedTicket={selectedWorker}
                otelHealth={otelHealth}
                commsAuthors={commsAuthors}
                onCommsLink={onCommsLink}
              />
            </div>
          </div>
        )}

        {activeTab === "workers" && (
          <div key="workers" className="animate-fade-in-fast">
            <WorkerTable
              orch={orch}
              getAnalytics={getAnalytics}
              getLinear={getLinear}
              staleThreshold={staleThreshold}
              onWorkerSelect={setSelectedWorker}
              selectedTicket={selectedWorker}
              otelHealth={otelHealth}
              commsAuthors={commsAuthors}
              onCommsLink={onCommsLink}
            />
          </div>
        )}

        {activeTab === "timeline" && (
          <div key="timeline" className="animate-fade-in-fast">
            <GanttChart orch={orch} getAnalytics={getAnalytics} />
          </div>
        )}

        {activeTab === "events" && (
          <div key="events" className="animate-fade-in-fast">
            <EventLog events={events} filterOrchId={orch.id} />
          </div>
        )}

        {activeTab === "briefing" && showBriefing && (
          <div key="briefing" className="animate-fade-in-fast">
            <BriefingTab orch={orch} />
          </div>
        )}
      </Panel>

      {selectedWorker && selectedW && (
        <WorkerDetailDrawer
          orchId={orch.id}
          ticket={selectedWorker}
          worker={selectedW}
          analytics={getAnalytics(orch.id)[selectedWorker] || null}
          linear={getLinear(selectedWorker)}
          onClose={() => setSelectedWorker(null)}
        />
      )}
    </div>
  );
}
