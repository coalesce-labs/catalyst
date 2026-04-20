import { useState, useCallback, useEffect, lazy, Suspense } from "react";
import { useMonitor } from "./hooks/use-monitor";
import { useKeyboardNav } from "./hooks/use-keyboard-nav";
import { Sidebar } from "./components/layout/sidebar";
import { AttentionBar } from "./components/attention-bar";
import { SessionDetailDrawer } from "./components/session-detail-drawer";
import { ConnectionBanner } from "./components/ui/connection-banner";
import { OtelHealthBanner } from "./components/ui/otel-health-banner";
import { SkeletonDashboard } from "./components/ui/skeleton";
import { ChevronRight, Home, PanelLeftClose, PanelLeft } from "lucide-react";
import type { GroupingMode } from "./lib/grouping";
import { SESSION_TIME_FILTERS, type SessionTimeFilter } from "./lib/types";

const Dashboard = lazy(() =>
  import("./components/dashboard").then((m) => ({ default: m.Dashboard })),
);
const OrchestratorView = lazy(() =>
  import("./components/orchestrator-view").then((m) => ({
    default: m.OrchestratorView,
  })),
);
const Sandbox = lazy(() =>
  import("./components/dev/sandbox").then((m) => ({ default: m.Sandbox })),
);

const isDevSandbox =
  typeof window !== "undefined" &&
  new URLSearchParams(window.location.search).get("dev") === "1";

export default function App() {
  if (isDevSandbox) {
    return (
      <div className="h-screen overflow-y-auto bg-surface-0 text-fg">
        <Suspense fallback={null}>
          <Sandbox />
        </Suspense>
      </div>
    );
  }
  return <Monitor />;
}

function Monitor() {
  const {
    snapshot,
    connectionStatus,
    events,
    attention,
    sessions,
    analytics,
    linear,
    otelHealth,
    staleThreshold,
  } = useMonitor();

  const [selectedOrchId, setSelectedOrchId] = useState<string | null>(null);
  const [selectedSession, setSelectedSession] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [groupingMode, setGroupingMode] = useState<GroupingMode>(
    () => (localStorage.getItem("catalyst-sidebar-grouping") as GroupingMode) || "flat",
  );
  const [timeFilter, setTimeFilter] = useState<SessionTimeFilter>(() => {
    const stored = localStorage.getItem("catalyst-session-filter");
    return SESSION_TIME_FILTERS.includes(stored as SessionTimeFilter)
      ? (stored as SessionTimeFilter)
      : "active";
  });
  const [version, setVersion] = useState<string | null>(null);

  const handleGroupingChange = useCallback((mode: GroupingMode) => {
    setGroupingMode(mode);
    localStorage.setItem("catalyst-sidebar-grouping", mode);
  }, []);

  const handleTimeFilterChange = useCallback((filter: SessionTimeFilter) => {
    setTimeFilter(filter);
    localStorage.setItem("catalyst-session-filter", filter);
  }, []);

  useEffect(() => {
    fetch("/api/version")
      .then((r) => r.json())
      .then((d) => setVersion(d.version))
      .catch(() => {});
  }, []);

  useKeyboardNav({
    onEscape: () => {
      setSelectedOrchId(null);
      setSelectedSession(null);
    },
  });

  const selectedOrch = selectedOrchId
    ? snapshot.orchestrators.find((o: { id: string }) => o.id === selectedOrchId)
    : null;

  const effectiveOrch =
    selectedOrchId && !selectedOrch ? null : selectedOrch;

  const handleSelect = useCallback((orchId: string | null) => {
    setSelectedOrchId(orchId);
    setSelectedSession(null);
  }, []);

  const handleSessionSelect = useCallback((sessionId: string) => {
    setSelectedSession(sessionId);
    setSelectedOrchId(null);
  }, []);

  const handleAttentionClick = useCallback(
    (orchId: string, _ticket: string) => {
      setSelectedOrchId(orchId);
      setSelectedSession(null);
    },
    [],
  );

  return (
    <div className="flex h-screen bg-surface-0 text-fg">
      <Sidebar
        orchestrators={snapshot.orchestrators}
        sessions={sessions}
        selectedOrchId={effectiveOrch ? selectedOrchId : null}
        onSelect={handleSelect}
        selectedSessionId={selectedSession}
        onSessionSelect={handleSessionSelect}
        connectionStatus={connectionStatus}
        attentionCount={attention.length}
        collapsed={!sidebarOpen}
        onToggle={() => setSidebarOpen((o) => !o)}
        groupingMode={groupingMode}
        onGroupingModeChange={handleGroupingChange}
        timeFilter={timeFilter}
        onTimeFilterChange={handleTimeFilterChange}
      />

      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <header className="flex items-center justify-between border-b border-border bg-surface-1 px-5 py-2.5">
          <div className="flex items-center gap-2">
            <button
              onClick={() => setSidebarOpen((o) => !o)}
              className="rounded p-1 text-muted transition-colors hover:bg-surface-3 hover:text-fg"
              aria-label="Toggle sidebar"
            >
              {sidebarOpen ? (
                <PanelLeftClose className="h-4 w-4" />
              ) : (
                <PanelLeft className="h-4 w-4" />
              )}
            </button>
            <nav className="flex items-center gap-1.5 text-[13px]">
              <button
                onClick={() => setSelectedOrchId(null)}
                className="flex items-center gap-1 text-muted transition-colors hover:text-fg"
              >
                <Home className="h-3.5 w-3.5" />
                Dashboard
              </button>
              {effectiveOrch && (
                <>
                  <ChevronRight className="h-3 w-3 text-border" />
                  <span className="font-mono font-medium text-fg">
                    {effectiveOrch.id}
                  </span>
                </>
              )}
            </nav>
          </div>
          <div className="flex items-center gap-3 text-[12px] text-muted">
            {snapshot.timestamp && (
              <span>
                {new Date(snapshot.timestamp).toLocaleDateString(undefined, {
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                })}{" "}
                {new Date(snapshot.timestamp).toLocaleTimeString()}
              </span>
            )}
            {version && (
              <span className="font-mono opacity-50">v{version}</span>
            )}
          </div>
        </header>

        <ConnectionBanner status={connectionStatus} className="mx-5 mt-3" />
        <OtelHealthBanner health={otelHealth} className="mx-5 mt-3" />

        <div className="flex-1 overflow-y-auto p-5">
          <Suspense fallback={<SkeletonDashboard />}>
            {effectiveOrch ? (
              <div key={effectiveOrch.id} className="animate-fade-in flex flex-col gap-4">
                {attention.filter((a) => a.orchId === effectiveOrch.id)
                  .length > 0 && (
                  <AttentionBar
                    items={attention.filter(
                      (a) => a.orchId === effectiveOrch.id,
                    )}
                    onItemClick={handleAttentionClick}
                  />
                )}
                <OrchestratorView
                  orch={effectiveOrch}
                  events={events}
                  getAnalytics={analytics}
                  getLinear={linear}
                  staleThreshold={staleThreshold}
                  otelHealth={otelHealth}
                />
              </div>
            ) : (
              <div className="animate-fade-in">
                <Dashboard
                  orchestrators={snapshot.orchestrators}
                  sessions={sessions}
                  attention={attention}
                  events={events}
                  getAnalytics={analytics}
                  onSelectOrch={(id) => setSelectedOrchId(id)}
                  selectedSessionId={selectedSession}
                  onSessionSelect={handleSessionSelect}
                  timeFilter={timeFilter}
                />
              </div>
            )}
          </Suspense>
        </div>
      </main>

      {selectedSession &&
        (() => {
          const s = sessions.find((s) => s.sessionId === selectedSession);
          return s ? (
            <SessionDetailDrawer
              session={s}
              onClose={() => setSelectedSession(null)}
            />
          ) : null;
        })()}
    </div>
  );
}
