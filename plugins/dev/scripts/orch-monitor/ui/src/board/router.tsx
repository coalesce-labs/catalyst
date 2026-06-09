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
//                    renders a placeholder detail container (body filled later by
//                    the DETAIL stream — out of scope for FND1).
//   /worker/$id    → same shape; `id` is e.g. "CTL-845:2" (a colon is legal
//                    inside a single path segment, so the run-id resolves whole).
//
// Detail-page bodies, the Sidebar nav frame (SHELL stream), and the jotai store
// are explicitly NOT in this ticket — this is purely the routing skeleton and
// the typed search-param contract (route-search.ts) everything else binds to.
import { StrictMode } from "react";
import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { Board } from "./Board";
import { validateDetailSearch } from "./route-search";

// Root route: holds the <Outlet> the matched child renders into. No chrome yet
// (the Sidebar/SHELL frame is a later ticket) — the root is a bare passthrough
// so `/` paints exactly today's board with no visual regression.
const rootRoute = createRootRoute({
  component: () => <Outlet />,
});

// `/` — the existing board, mounted unchanged.
const boardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: Board,
});

// `/ticket/$id` — typed id param + typed search contract. Body is a placeholder
// container the DETAIL stream fills in a later ticket; for FND1 the route just
// has to resolve, expose the typed param, and parse the search params safely.
const ticketRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/ticket/$id",
  validateSearch: validateDetailSearch,
  component: TicketDetailPlaceholder,
});

// `/worker/$id` — single-run page. Same typed param + search contract.
const workerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/worker/$id",
  validateSearch: validateDetailSearch,
  component: WorkerDetailPlaceholder,
});

function TicketDetailPlaceholder() {
  const { id } = ticketRoute.useParams();
  return (
    <div data-detail-kind="ticket" data-detail-id={id} style={PLACEHOLDER_STYLE}>
      ticket {id}
    </div>
  );
}

function WorkerDetailPlaceholder() {
  const { id } = workerRoute.useParams();
  return (
    <div data-detail-kind="worker" data-detail-id={id} style={PLACEHOLDER_STYLE}>
      worker {id}
    </div>
  );
}

// Minimal, theme-neutral placeholder so the route renders something while the
// real detail body is out of scope (filled by the DETAIL stream later).
const PLACEHOLDER_STYLE = {
  padding: "24px",
  color: "#8b93a1",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
} as const;

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
