// router.tsx — the orch-monitor app-wide routing skeleton (CTL-881 / FND1).
//
// The board was a route-less React tree: main.tsx mounted <Board /> directly,
// so nothing was deep-linkable and a refresh/paste could not reconstruct where
// you were. This adopts @tanstack/react-router (greenfield — the redesign's
// whole detail-page spine sits on it) and defines three routes:
//
//   /              → the existing <Board /> (mounted unchanged; the SharedWorker
//                    board stream in board-client.ts is untouched — routing wraps
//                    the tree, it never touches data flow).
//   /ticket/$id    → typed `id` param + typed `?from&lens&col&cursor` search;
//                    renders the shared detail-page <Shell> chrome (CTL-912 /
//                    DETAIL1) with a ticket-body placeholder slot (the body itself
//                    is DETAIL2).
//   /worker/$id    → same shape; `id` is e.g. "CTL-845:2" (a colon is legal
//                    inside a single path segment, so the run-id resolves whole).
//                    Renders the shared <Shell> with a worker-body slot (DETAIL3).
//
// CTL-912 / DETAIL1 wires the shared shell chrome (breadcrumb · pager · live-dot
// title · Properties rail · footer · keyboard) into these routes; the per-page
// BODIES (spine/telemetry/runs, burn-strip/tail/diagnostics) drop into the slot in
// later DETAIL tickets. The Sidebar nav frame (SHELL stream) is still separate.
import { StrictMode } from "react";
import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  useNavigate,
} from "@tanstack/react-router";
import { Board } from "./Board";
import { validateDetailSearch } from "./route-search";
import { TicketDetailRoute, WorkerDetailRoute } from "./detail-route";

// Root route: holds the <Outlet> the matched child renders into. No chrome yet
// (the Sidebar/SHELL frame is a later ticket) — the root is a bare passthrough
// so `/` paints exactly today's board with no visual regression.
const rootRoute = createRootRoute({
  component: () => <Outlet />,
});

// `/` — the existing board. CTL-909 / SURF1: a thin wrapper injects the
// worker-card deep-link (onWorkerSelect → navigate to `/worker/$id`) so the
// Workers grid's cards open the single-run detail page. The Board itself stays
// router-free (it also mounts in the embedded, router-less app shell).
function BoardRoot() {
  const navigate = useNavigate();
  return (
    <Board
      onWorkerSelect={(name) =>
        void navigate({ to: "/worker/$id", params: { id: name }, search: { from: "board" } })
      }
    />
  );
}
const boardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: BoardRoot,
});

// `/ticket/$id` — typed id param + typed search contract. Renders the shared
// detail-page <Shell> (CTL-912 / DETAIL1) with a ticket-body slot (DETAIL2).
const ticketRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/ticket/$id",
  validateSearch: validateDetailSearch,
  component: TicketDetailContainer,
});

// `/worker/$id` — single-run page. Same typed param + search contract; renders the
// shared <Shell> with a worker-body slot (DETAIL3).
const workerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/worker/$id",
  validateSearch: validateDetailSearch,
  component: WorkerDetailContainer,
});

function TicketDetailContainer() {
  const { id } = ticketRoute.useParams();
  const search = ticketRoute.useSearch();
  return <TicketDetailRoute id={id} search={search} />;
}

function WorkerDetailContainer() {
  const { id } = workerRoute.useParams();
  const search = workerRoute.useSearch();
  return <WorkerDetailRoute id={id} search={search} />;
}

const routeTree = rootRoute.addChildren([boardRoute, ticketRoute, workerRoute]);

export const router = createRouter({ routeTree });

// Register the router instance type so `Link`, `useParams`, `useSearch`, etc.
// are fully typed app-wide against this exact route tree (standard TanStack
// type-registration pattern).
declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

/** Wrap the whole app in the router. Mounted by main.tsx inside #board-root. */
export function AppRouter() {
  return (
    <StrictMode>
      <RouterProvider router={router} />
    </StrictMode>
  );
}
