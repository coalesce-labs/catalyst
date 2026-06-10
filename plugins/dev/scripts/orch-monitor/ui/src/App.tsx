import {
  useMemo,
  useState,
  useCallback,
  useEffect,
  lazy,
  Suspense,
  type ReactNode,
} from "react";
import { useMonitor } from "./hooks/use-monitor";
import { useKeyboardNav } from "./hooks/use-keyboard-nav";
import { useCommsChannels } from "./hooks/use-comms";
import { AppShell } from "./components/app-shell";
// CTL-892 / SHELL2: the surface→content map + the dense board, now hosted inside
// the shared shell instead of its own shell-less board.html page.
// CTL-899 / HOME1: the same switch also mounts the calm Inbox HOME surface for
// surface === "home" (before the board check), falling through to the dashboard
// for every other surface.
import { useSurface } from "./lib/surface";
import { surfaceContentKind } from "./lib/surface-content";
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
// CTL-945: Board is eagerly imported (not lazy) to eliminate the HTTP/1.1
// connection-slot race: with 4 persistent EventSources after the CTL-945 context
// fix, a lazy chunk fetch would still compete for slots during startup. Eager
// import guarantees the Board component is in the main bundle — no chunk fetch
// needed at navigation time. The board-worker SharedWorker is still a separate
// chunk (Vite compiles it independently), so the incremental bundle cost is only
// the Board UI code itself. The Suspense boundary in SurfaceSwitch is retained
// for HomeSurface / QueueSurface which remain lazy.
// CTL-892 / SHELL2: the dense board lives in the shell.
import { Board } from "./board/Board";
// CTL-899 / HOME1: the calm master-detail Inbox HOME surface. Lazy so its
// transport (board snapshot SSE) + master-detail tree only load when the operator
// is on Home — the dashboard surfaces stay untouched.
const HomeSurface = lazy(() =>
  import("./components/home/home-surface").then((m) => ({
    default: m.HomeSurface,
  })),
);
// CTL-910 / SURF2: the dedicated wide Queue surface. Lazy so its transport (the
// shared board snapshot SSE) + the ranked depth table only load when the operator
// is on the Queue surface — the dashboard + home surfaces stay untouched.
const QueueSurface = lazy(() =>
  import("./components/queue/queue-surface").then((m) => ({
    default: m.QueueSurface,
  })),
);
// OBS-5: the OBSERVE Telemetry surface. Lazy/code-split so the chart-kit (recharts
// pulled in by the observe components) never ships in the home/board main bundle —
// it only loads when the operator is on the Telemetry surface.
const TelemetrySurface = lazy(() =>
  import("./components/observe/telemetry-surface").then((m) => ({
    default: m.TelemetrySurface,
  })),
);
// OBS-10: the OBSERVE FinOps surface. Lazy/code-split like Telemetry so the
// chart-kit (recharts) chunk only loads when the operator is on FinOps.
const FinopsSurface = lazy(() =>
  import("./components/observe/finops-surface").then((m) => ({
    default: m.FinopsSurface,
  })),
);
// OBS-16: the OBSERVE Utilization surface. Lazy/code-split like the others so its
// chunk only loads when the operator is on Utilization.
const UtilizationSurface = lazy(() =>
  import("./components/observe/utilization-surface").then((m) => ({
    default: m.UtilizationSurface,
  })),
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

  // CTL-892 / SHELL2 + CTL-899 / HOME1: the existing dashboard tree, unchanged.
  // It's the inset content for every surface EXCEPT "home" (calm Inbox) and
  // "board" (dense grid); Workers/Queue still fall through to the dashboard today
  // — they migrate to dense surfaces in later SHELL tickets.
  const dashboardBody = (
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
  );

  return (
    // CTL-891 / SHELL1: the AppShell is the app frame — a full-viewport,
    // edge-to-edge shadcn Sidebar shell (controlled SidebarProvider + SidebarInset
    // + OPERATE/OBSERVE nav).
    // CTL-892 / SHELL2: the inset content is now surface-aware. When the active
    // surface is "board" the dense <Board /> grid renders full-bleed inside the
    // SidebarInset (embedded → fills the inset, not the viewport).
    // CTL-899 / HOME1: when surface === "home" the inset hosts the calm Inbox
    // master-detail surface; every other surface keeps the dashboard. SurfaceSwitch
    // reads SurfaceContext, so it MUST live inside AppShell (which provides it).
    <AppShell>
      <SurfaceSwitch dashboard={dashboardBody} />

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

// CTL-892 / SHELL2: the surface→content switch. A stable top-level component (NOT
// a closure inside Monitor) so the board's element keeps a fixed position in the
// tree while the board surface is selected — React reconciles it in place across
// Monitor re-renders, so the SharedWorker EventSource is NOT torn down and
// re-created on every snapshot tick ("board updates render without a second
// EventSource per tab"). The board is full-bleed and dense; the dashboard keeps
// its own (calmer) layout.
// CTL-899 / HOME1: the same switch mounts the calm Inbox HOME surface for
// surface === "home" (checked first), then the dense board, then falls through to
// the dashboard for Workers/Queue (no regression until their own SHELL tickets).
function SurfaceSwitch({ dashboard }: { dashboard: ReactNode }) {
  const { surface } = useSurface();
  if (surface === "home") {
    return (
      <Suspense fallback={<SkeletonDashboard />}>
        <HomeSurface />
      </Suspense>
    );
  }
  const kind = surfaceContentKind(surface);
  // CTL-930: SurfaceSwitch collapses to ONE <Board> branch with a controlled
  // view prop — workers surface opens board onto workers view; board surface
  // opens onto tickets view. Nav between them updates the surface via onViewChange.
  if (kind === "workers" || kind === "board") {
    return (
      <Suspense fallback={<SkeletonDashboard />}>
        <Board
          embedded
          view={kind === "workers" ? "workers" : "tickets"}
          onViewChange={(v) => {
            // Workers ⇄ Tickets switch reflects in the surface (no-op for routing context)
            // This is a visual-only internal switch; the nav item stays "board"/"workers".
            void v; // future: setSurface(v === "workers" ? "workers" : "board")
          }}
        />
      </Suspense>
    );
  }
  // CTL-910 / SURF2: the Queue surface is its OWN dedicated route now (no longer
  // the SHELL2 dashboard fall-through). Like the board it is a stable top-level
  // branch so its element keeps a fixed tree position and the shared board
  // EventSource is reconciled in place, not torn down on every snapshot tick.
  if (kind === "queue") {
    return (
      <Suspense fallback={<SkeletonDashboard />}>
        <QueueSurface />
      </Suspense>
    );
  }
  // OBS-5: the first OBSERVE surface. A lazy/code-split branch like the others so
  // its chart-kit chunk only loads on this surface. The other four OBSERVE
  // surfaces are nav-disabled ("soon") and still fall through to the dashboard.
  if (kind === "telemetry") {
    return (
      <Suspense fallback={<SkeletonDashboard />}>
        <TelemetrySurface />
      </Suspense>
    );
  }
  // OBS-10: the second OBSERVE surface. Same lazy/code-split branch as Telemetry.
  if (kind === "finops") {
    return (
      <Suspense fallback={<SkeletonDashboard />}>
        <FinopsSurface />
      </Suspense>
    );
  }
  // OBS-16: the third OBSERVE surface (Utilization). Same lazy/code-split branch.
  if (kind === "utilization") {
    return (
      <Suspense fallback={<SkeletonDashboard />}>
        <UtilizationSurface />
      </Suspense>
    );
  }
  return <>{dashboard}</>;
}
