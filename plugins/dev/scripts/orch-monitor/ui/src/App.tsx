import { useMemo, useState, useCallback, useEffect, lazy, Suspense } from "react";
import { useMonitor } from "./hooks/use-monitor";
import { useKeyboardNav } from "./hooks/use-keyboard-nav";
import { useCommsChannels } from "./hooks/use-comms";
import { AppShell } from "./components/app-shell";
import { AttentionBar } from "./components/attention-bar";
import { SessionDetailDrawer } from "./components/session-detail-drawer";
import { ConnectionBanner } from "./components/ui/connection-banner";
import { OtelHealthBanner } from "./components/ui/otel-health-banner";
import { SkeletonDashboard } from "./components/ui/skeleton";
import {
  SESSION_TIME_FILTERS,
  type SessionTimeFilter,
  type CommsFilter,
} from "./lib/types";

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
const CommsView = lazy(() =>
  import("./components/comms-view").then((m) => ({ default: m.CommsView })),
);
const ActivityView = lazy(() =>
  import("./components/activity-view").then((m) => ({ default: m.ActivityView })),
);
const GodModeView = lazy(() =>
  import("./components/god-mode-view").then((m) => ({ default: m.GodModeView })),
);

type TopView = "dashboard" | "comms" | "activity" | "god-mode";

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
    otelTools,
    otelErrors,
    staleThreshold,
  } = useMonitor();

  const [selectedOrchId, setSelectedOrchId] = useState<string | null>(null);
  const [selectedSession, setSelectedSession] = useState<string | null>(null);
  // `selectedWorker` is lifted up from `OrchestratorView` so the Activity pane
  // can pivot directly to a worker drawer via cross-link chips.
  const [selectedWorker, setSelectedWorker] = useState<string | null>(null);
  // CTL-891 / SHELL1: the AppShell now owns sidebar collapse + the grouping
  // affordance moved off the frame; the dashboard content keeps its own
  // time-filter (set by internal controls) and topView switching.
  const [topView, setTopView] = useState<TopView>("dashboard");
  const [commsInitialFilter, setCommsInitialFilter] =
    useState<CommsFilter | null>(null);
  const [timeFilter] = useState<SessionTimeFilter>(() => {
    const stored = localStorage.getItem("catalyst-session-filter");
    return SESSION_TIME_FILTERS.includes(stored as SessionTimeFilter)
      ? (stored as SessionTimeFilter)
      : "active";
  });
  const [version, setVersion] = useState<string | null>(null);

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

  const handleSessionSelect = useCallback((sessionId: string) => {
    setSelectedSession(sessionId);
    setSelectedOrchId(null);
    setSelectedWorker(null);
    setTopView("dashboard");
  }, []);

  const handleActivityPivot = useCallback(
    (orchId: string, ticket: string) => {
      setSelectedOrchId(orchId);
      setSelectedWorker(ticket);
      setSelectedSession(null);
      setTopView("dashboard");
    },
    [],
  );

  const { channels: commsChannels } = useCommsChannels(true);
  const authorsByOrchId = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const c of commsChannels) {
      if (!c.orchId) continue;
      const set = m.get(c.orchId) ?? new Set<string>();
      for (const a of c.authors) set.add(a);
      m.set(c.orchId, set);
    }
    return m;
  }, [commsChannels]);

  const commsAuthorsForSelected =
    effectiveOrch && authorsByOrchId.get(effectiveOrch.id);

  const handleWorkerCommsLink = useCallback(
    (ticket: string) => {
      if (!effectiveOrch) return;
      // CTL-373: channel name is the orch-id directly (legacy: `orch-${id}`).
      const channelName = effectiveOrch.id.startsWith("orch-")
        ? `orch-${effectiveOrch.id}`
        : effectiveOrch.id;
      setCommsInitialFilter({
        channel: channelName,
        author: ticket,
        types: null,
      });
      setTopView("comms");
    },
    [effectiveOrch],
  );

  const handleAttentionClick = useCallback(
    (orchId: string, _ticket: string) => {
      setSelectedOrchId(orchId);
      setSelectedSession(null);
    },
    [],
  );

  return (
    // CTL-891 / SHELL1: the AppShell is now the app frame — a full-viewport,
    // edge-to-edge shadcn Sidebar shell (controlled SidebarProvider + SidebarInset
    // + OPERATE/OBSERVE nav). The existing dashboard content renders edge-to-edge
    // inside the inset. Surface→content wiring (Board/Workers/Queue) and live
    // badges are later SHELL tickets; here the dashboard is the inset content.
    <AppShell>
      <div className="flex h-full min-h-0 flex-col bg-surface-0 text-fg">
        {/* Content-level meta row: snapshot timestamp + version. The frame's
            breadcrumb + collapse live in the AppShell top strip now. */}
        <div className="flex items-center justify-end gap-3 border-b border-border bg-surface-1 px-5 py-2 text-[12px] text-muted">
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
          {version && <span className="font-mono opacity-50">v{version}</span>}
        </div>

        <ConnectionBanner status={connectionStatus} className="mx-5 mt-3" />
        <OtelHealthBanner health={otelHealth} className="mx-5 mt-3" />

        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          <Suspense fallback={<SkeletonDashboard />}>
            {topView === "comms" ? (
              <div className="animate-fade-in">
                <CommsView initialFilter={commsInitialFilter} />
              </div>
            ) : topView === "activity" ? (
              <div className="animate-fade-in">
                <ActivityView onPivot={handleActivityPivot} />
              </div>
            ) : topView === "god-mode" ? (
              <div className="animate-fade-in">
                <GodModeView />
              </div>
            ) : effectiveOrch ? (
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
                  commsAuthors={commsAuthorsForSelected || undefined}
                  onCommsLink={handleWorkerCommsLink}
                  selectedWorker={selectedWorker}
                  onWorkerSelect={setSelectedWorker}
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
                  otelConfigured={otelHealth?.configured === true}
                  otelTools={otelTools}
                  otelErrors={otelErrors}
                />
              </div>
            )}
          </Suspense>
        </div>
      </div>

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
    </AppShell>
  );
}
