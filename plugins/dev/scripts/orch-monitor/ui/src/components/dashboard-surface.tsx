// dashboard-surface.tsx — the rich monitor dashboard surface (CTL-989).
//
// Extracted from the legacy App.tsx `Monitor` body. Before CTL-989 this content
// was the SurfaceSwitch `dashboard` fall-through (reachable only for the
// `devops` surface) and lived inside the single `Monitor` component that also
// rendered AppShell. The router unification (CTL-989) makes AppShell the
// rootRoute LAYOUT, so each surface is a self-contained route component rendered
// inside the layout's <Outlet/>. This component is the dashboard route: it owns
// the `useMonitor()` transport (the orchestrator/comms/activity/god-mode views +
// the session-detail drawer) and is mounted ONLY when the operator is on the
// dashboard route — so its EventSources never open on the calm Home/Board paths.
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  Suspense,
  lazy,
} from "react";
import { useMonitor } from "../hooks/use-monitor";
import { useKeyboardNav } from "../hooks/use-keyboard-nav";
import { useCommsChannels } from "../hooks/use-comms";
import { AttentionBar } from "./attention-bar";
import { SessionDetailDrawer } from "./session-detail-drawer";
import { ConnectionBanner } from "./ui/connection-banner";
import { OtelHealthBanner } from "./ui/otel-health-banner";
import { SkeletonDashboard } from "./ui/skeleton";
import {
  SESSION_TIME_FILTERS,
  type SessionTimeFilter,
  type CommsFilter,
} from "../lib/types";

const Dashboard = lazy(() =>
  import("./dashboard").then((m) => ({ default: m.Dashboard })),
);
const OrchestratorView = lazy(() =>
  import("./orchestrator-view").then((m) => ({
    default: m.OrchestratorView,
  })),
);
const CommsView = lazy(() =>
  import("./comms-view").then((m) => ({ default: m.CommsView })),
);
const ActivityView = lazy(() =>
  import("./activity-view").then((m) => ({ default: m.ActivityView })),
);
const GodModeView = lazy(() =>
  import("./god-mode-view").then((m) => ({ default: m.GodModeView })),
);

type TopView = "dashboard" | "comms" | "activity" | "god-mode";

export function DashboardSurface() {
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
  const [selectedWorker, setSelectedWorker] = useState<string | null>(null);
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

  const effectiveOrch = selectedOrchId && !selectedOrch ? null : selectedOrch;

  const handleSessionSelect = useCallback((sessionId: string) => {
    setSelectedSession(sessionId);
    setSelectedOrchId(null);
    setSelectedWorker(null);
    setTopView("dashboard");
  }, []);

  const handleActivityPivot = useCallback((orchId: string, ticket: string) => {
    setSelectedOrchId(orchId);
    setSelectedWorker(ticket);
    setSelectedSession(null);
    setTopView("dashboard");
  }, []);

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

  const handleAttentionClick = useCallback((orchId: string, _ticket: string) => {
    setSelectedOrchId(orchId);
    setSelectedSession(null);
  }, []);

  return (
    <>
      <div className="flex h-full min-h-0 flex-col bg-background text-fg">
        {/* Content-level meta row: snapshot timestamp + version. The frame's
            breadcrumb + collapse live in the AppShell top strip now. */}
        <div className="flex items-center justify-end gap-3 border-b border-border-subtle bg-background px-5 py-2 text-[12px] text-muted">
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
              <div
                key={effectiveOrch.id}
                className="animate-fade-in flex flex-col gap-4"
              >
                {attention.filter((a) => a.orchId === effectiveOrch.id).length >
                  0 && (
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
    </>
  );
}
