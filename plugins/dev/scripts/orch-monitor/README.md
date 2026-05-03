# orch-monitor

A local websocket server + React UI that visualises Catalyst orchestrator runs: active orchestrators, workers, phase timelines, event logs, cost and token usage, detail drawers.

The server (`server.ts`) watches `~/catalyst/state.json` and the event stream, and broadcasts snapshots to the browser. The UI (`ui/`) is a Vite + React 19 + Tailwind app that renders those snapshots.

## Running locally

```
bun run dev:ui     # Vite dev server for the UI (http://localhost:5173 → proxies to server)
```

The server is started out-of-band (see `server.ts` and the wrapper script in `plugins/dev/scripts/`). The UI assumes the server is reachable at `http://localhost:7400`.

## Committing UI changes

When modifying anything in `ui/`, run a production build and commit the regenerated bundle alongside the source:

```
bun run build:ui
```

This rewrites `public/index.html` with fresh `public/assets/index-*.{js,css}` references. The committed `public/index.html` must always point to a bundle that exists in `public/assets/`, otherwise the static-asset tests in `server.test.ts` and `ui-features.test.ts` go red.

## UI design

See [`ui/DESIGN.md`](ui/DESIGN.md) for the design language of the monitor — surface tokens, status semantics, spacing, typography, and the policy for when to hand-roll components vs. reach for [shadcn/ui][shadcn] primitives. Read it before adding a new screen, drawer, or component.

[shadcn]: https://ui.shadcn.com
