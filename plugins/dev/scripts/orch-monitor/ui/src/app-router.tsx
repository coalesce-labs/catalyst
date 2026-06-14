// app-router.tsx — the SINGLE app-wide TanStack Router (CTL-989).
//
// THE UNIFICATION: before CTL-989 the orch-monitor shipped as TWO SPA bundles —
// index.html (the AppShell, with the active surface held in `useState<Surface>`)
// and the standalone board.html (its OWN TanStack Router carrying /ticket/$id,
// /worker/$id, /dep-graph with a bare <Outlet/> root, NO left nav). The URL did
// not reflect the surface, detail navigation was a full-document jump, and the
// detail pages had no shell chrome.
//
// This module is the ONE router mounted from index.html (main.tsx →
// RouterProvider). The rootRoute renders <AppShell><Outlet/></AppShell> so the
// AppShell becomes the LAYOUT wrapping EVERY screen — every surface AND every
// detail page renders inside the same left-nav/top/bottom chrome. The URL is now
// the source of truth for LOCATION: each surface is a real path
// (route-surface.ts), so refresh/paste/back-forward reconstruct the screen from
// the URL alone, and detail pages keep the left nav.
//
// Pass A (CTL-989/A) stands up the router skeleton + the layout route + every
// route, COMPILING, with the surfaces rendering their existing components inside
// the layout's <Outlet/>. The full retirement of the legacy `useState<Surface>`
// + SurfaceContext.setSurface + hardNavigate nav is Pass B.
import { lazy, Suspense } from "react";
import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  redirect,
  useParams,
  useSearch,
} from "@tanstack/react-router";

import { AppShell } from "./components/app-shell";
import { SkeletonDashboard } from "./components/ui/skeleton";
import { validateDetailSearch } from "./board/route-search";
import { validateRootSearch } from "./lib/root-search";
import { surfaceToPath } from "./lib/route-surface";
import { readLandingSurface, shouldApplyLandingRedirect } from "./lib/prefs";

// CTL-1059: capture the URL the operator actually hard-loaded, evaluated once
// at module import time (before the router processes any route). This reflects
// the true cold-load path, not a later in-session `/` visit.
const INITIAL_PATHNAME =
  typeof window !== "undefined" ? window.location.pathname : "/";

// ── surface components (the existing surfaces, code-split as before) ──────────
// Home / Queue / the OBSERVE surfaces stay lazy (HomeSurface pulls its
// master-detail transport; the OBSERVE surfaces pull the recharts chart-kit) so
// the main bundle stays lean — the SAME discipline App.tsx applied. The Board is
// eager (imported, not lazy): with 4 persistent EventSources after CTL-945 a lazy
// chunk fetch would still race for HTTP/1.1 connection slots at startup, so the
// Board UI ships in the main bundle (its SharedWorker is still a separate chunk).
import { Board } from "./board/Board";

const HomeSurface = lazy(() =>
  import("./components/home/home-surface").then((m) => ({
    default: m.HomeSurface,
  })),
);
const TelemetrySurface = lazy(() =>
  import("./components/observe/telemetry-surface").then((m) => ({
    default: m.TelemetrySurface,
  })),
);
const FinopsSurface = lazy(() =>
  import("./components/observe/finops-surface").then((m) => ({
    default: m.FinopsSurface,
  })),
);
const UtilizationSurface = lazy(() =>
  import("./components/observe/utilization-surface").then((m) => ({
    default: m.UtilizationSurface,
  })),
);
const FleetOpsSurface = lazy(() =>
  import("./components/observe/fleetops-surface").then((m) => ({
    default: m.FleetOpsSurface,
  })),
);
const SettingsSurface = lazy(() =>
  import("./components/settings-surface").then((m) => ({
    default: m.SettingsSurface,
  })),
);
// The rich monitor dashboard (orchestrator/comms/activity/god-mode + session
// drawer) — extracted from the legacy App.tsx Monitor body. Lazy so its
// useMonitor() EventSources only open on the dashboard route.
const DashboardSurface = lazy(() =>
  import("./components/dashboard-surface").then((m) => ({
    default: m.DashboardSurface,
  })),
);
const RulebookSurface = lazy(() =>
  import("./components/rulebook/rulebook-surface").then((m) => ({
    default: m.RulebookSurface,
  })),
);

// ── detail routes (code-split — the entry-split that forced board.html to ship
//    them eagerly is gone, so split them now to keep the main bundle lean) ─────
const TicketDetailRoute = lazy(() =>
  import("./board/detail-route").then((m) => ({ default: m.TicketDetailRoute })),
);
const WorkerDetailRoute = lazy(() =>
  import("./board/detail-route").then((m) => ({ default: m.WorkerDetailRoute })),
);
const DepGraphRoute = lazy(() =>
  import("./board/dep-graph-route").then((m) => ({ default: m.DepGraphRoute })),
);

// ── helpers ───────────────────────────────────────────────────────────────────
/** Wrap a lazy surface in the shared dashboard skeleton fallback (the same
 *  Suspense discipline the legacy SurfaceSwitch used). */
function S({ children }: { children: React.ReactNode }) {
  return <Suspense fallback={<SkeletonDashboard />}>{children}</Suspense>;
}

// ── root layout route ─────────────────────────────────────────────────────────
// The AppShell is the layout: left nav + top strip + footer chrome, with the
// matched child route rendered into the <Outlet/> in its content slot. The root
// `validateSearch` makes `?scope=` a typed param inherited by every child route
// (the repo scope — see route-search.ts for the per-detail params).
const rootRoute = createRootRoute({
  validateSearch: validateRootSearch,
  component: function RootLayout() {
    return (
      <AppShell>
        <Outlet />
      </AppShell>
    );
  },
});

// ── surface routes ────────────────────────────────────────────────────────────
// NOTE (CTL-989): route `path`s MUST be string LITERALS — TanStack Router infers
// the typed route tree (the `to` union for navigate/Link) from literal paths, so
// a computed `path: SURFACE_PATH.board` would erase the literal and break typed
// navigation. The literals here are kept byte-identical to SURFACE_PATH in
// route-surface.ts (the route-surface.test.ts pins that map); a drift would show
// up as a typed-navigate error at the call site.
const homeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  // CTL-989: honor a persisted non-home landing preference. `readLandingSurface`
  // (lib/prefs.ts — the Settings write path is unchanged) seeds the FIRST screen
  // on a fresh load: if the operator chose a non-home landing surface, a one-shot
  // beforeLoad redirect lands them there. A real "/" navigation with a preference
  // of "home" (the default) is a no-op, so this never traps the operator on a
  // surface they explicitly navigated to via the URL.
  // CTL-1059: guard against deep-link initial loads — the redirect only fires
  // when the app was genuinely hard-loaded at `/`, not when a `/` visit happens
  // during a deep-link session (e.g. via a stray history.back()).
  beforeLoad: () => {
    const pref = readLandingSurface();
    if (shouldApplyLandingRedirect({ initialPathname: INITIAL_PATHNAME, pref })) {
      throw redirect({ to: surfaceToPath(pref), search: (prev) => prev });
    }
  },
  component: () => (
    <S>
      <HomeSurface />
    </S>
  ),
});

// Tickets + Workers are the SAME <Board>, opened on their respective view. The
// board fills the layout's content slot (embedded → fills the inset, not the
// viewport). The view IS the route (/board vs /workers) — the left nav navigates
// between them; there is no in-board view toggle.
const boardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/board",
  component: () => (
    <S>
      <Board embedded view="tickets" />
    </S>
  ),
});

const workersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/workers",
  component: () => (
    <S>
      <Board embedded view="workers" />
    </S>
  ),
});

// CTL-1016: /dispatch and /queue redirect to /workers. Bookmarks and shared
// links keep working; the Dispatch surface is retired and folded into Workers.
const dispatchRedirectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/dispatch",
  beforeLoad: () => { throw redirect({ to: "/workers", search: (prev) => prev }); },
});

const queueAliasRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/queue",
  beforeLoad: () => { throw redirect({ to: "/workers", search: (prev) => prev }); },
});

const telemetryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/telemetry",
  component: () => (
    <S>
      <TelemetrySurface />
    </S>
  ),
});

const utilizationRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/utilization",
  component: () => (
    <S>
      <UtilizationSurface />
    </S>
  ),
});

const finopsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/finops",
  component: () => (
    <S>
      <FinopsSurface />
    </S>
  ),
});

const fleetopsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/fleetops",
  component: () => (
    <S>
      <FleetOpsSurface />
    </S>
  ),
});

// DevOps surface — the rich monitor dashboard fall-through (orchestrator/comms/
// activity/god-mode). Kept as its own route so the dashboard stays reachable.
const devopsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/devops",
  component: () => (
    <S>
      <DashboardSurface />
    </S>
  ),
});

const rulebookRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/rules",
  component: () => (
    <S>
      <RulebookSurface />
    </S>
  ),
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  component: () => (
    <S>
      <SettingsSurface />
    </S>
  ),
});

// ── detail routes (rendered INSIDE AppShell's <Outlet/> — left nav stays) ─────
const ticketRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/ticket/$id",
  validateSearch: validateDetailSearch,
  component: function TicketDetailContainer() {
    const { id } = useParams({ from: "/ticket/$id" });
    const search = useSearch({ from: "/ticket/$id" });
    return (
      <S>
        <TicketDetailRoute id={id} search={search} />
      </S>
    );
  },
});

const workerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/worker/$id",
  validateSearch: validateDetailSearch,
  component: function WorkerDetailContainer() {
    const { id } = useParams({ from: "/worker/$id" });
    const search = useSearch({ from: "/worker/$id" });
    return (
      <S>
        <WorkerDetailRoute id={id} search={search} />
      </S>
    );
  },
});

const depGraphRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/dep-graph",
  component: () => (
    <S>
      <DepGraphRoute />
    </S>
  ),
});

const routeTree = rootRoute.addChildren([
  homeRoute,
  boardRoute,
  workersRoute,
  dispatchRedirectRoute,
  queueAliasRoute,
  telemetryRoute,
  utilizationRoute,
  finopsRoute,
  fleetopsRoute,
  devopsRoute,
  rulebookRoute,
  settingsRoute,
  ticketRoute,
  workerRoute,
  depGraphRoute,
]);

// scrollRestoration: TanStack restores window + registered scrollable elements
// per history entry, so back-from-detail returns to the prior offset with no
// full reload (the manual sessionStorage scroll snapshot is retired in Pass B).
export const router = createRouter({ routeTree, scrollRestoration: true });

// Register the router instance type so Link/useParams/useSearch/useNavigate are
// fully typed app-wide against this exact route tree.
declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
