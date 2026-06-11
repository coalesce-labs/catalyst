import { StrictMode, Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { router } from "./app-router";
import "./app.css";

// CTL-989: ONE TanStack Router mounted from index.html (#root). The rootRoute
// renders <AppShell><Outlet/></AppShell>, so AppShell is the LAYOUT wrapping
// every screen and the URL is the source of truth for location. This replaces
// both the old <App/> (the route-less AppShell shell with useState<Surface>) and
// the standalone board.html entry (its own bare-root router).

// The `?dev=1` Sandbox short-circuit is kept as a PRE-router branch (the dev
// component gallery is intentionally outside the app chrome).
const Sandbox = lazy(() =>
  import("./components/dev/sandbox").then((m) => ({ default: m.Sandbox })),
);

const isDevSandbox =
  typeof window !== "undefined" &&
  new URLSearchParams(window.location.search).get("dev") === "1";

const root = createRoot(document.getElementById("root")!);

if (isDevSandbox) {
  root.render(
    <StrictMode>
      <div className="h-screen overflow-y-auto bg-background text-fg">
        <Suspense fallback={null}>
          <Sandbox />
        </Suspense>
      </div>
    </StrictMode>,
  );
} else {
  root.render(
    <StrictMode>
      <RouterProvider router={router} />
    </StrictMode>,
  );
}
