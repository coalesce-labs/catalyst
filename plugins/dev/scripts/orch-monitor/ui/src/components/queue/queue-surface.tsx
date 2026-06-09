// queue-surface.tsx — the dedicated wide Queue surface (CTL-910 / SURF2).
//
// SURF2 promotes the board's internal Queue tab into the app shell as its OWN
// edge-to-edge route. The shell (AppShell) already owns the Queue nav item, the
// `g q` chord, and the top strip + breadcrumb; this component is the inset BODY
// rendered when surface === "queue" (wired in App.tsx's SurfaceSwitch via
// surfaceContentKind === "queue").
//
// Data plane: the SAME cache-backed read-model snapshot the board + Inbox consume
// (useBoardSnapshot → connectBoard → ONE shared EventSource), so the queue is fed
// by the BFF read-model's queue entities (the eligible projection, globally
// ranked + host-stamped in lib/board-data.mjs) and NEVER a synchronous per-request
// Linear call (the SURF2 "fed by the read-model, not a Linear call" requirement).
//
// Rendering: it reuses the QueueView render verbatim (the width-hungry capacity
// strip + SlotBar + Stats + the in-flight table + the ranked waiting table) with
// `embedded` so it fills the inset's flex slot. QueueView itself adds the optional
// per-node column + group-by-node affordance, both gated behind the single-host
// identity no-op — so a single-node fleet reads exactly like today.
import { TooltipProvider } from "@/components/ui/tooltip";
// CTL-897 / SHELL7: the Queue consumes the workspace-SCOPED snapshot so the
// switcher's repo selection actually filters the ranked depth (All = unfiltered).
import { useScopedBoardSnapshot } from "@/hooks/use-scoped-board-snapshot";
import { QueueView } from "@/board/Board";

// The dark Catalyst board surface base color (orch-monitor DESIGN.md `s0`), kept
// in step with the Board root so the embedded QueueView's hard-coded surfaces sit
// on the same backdrop whether it is mounted standalone or in the shell.
const SURFACE_BG = "#0b0d10";

export function QueueSurface() {
  const { payload, status } = useScopedBoardSnapshot();

  return (
    <TooltipProvider delayDuration={200}>
      <div
        className="flex h-full min-h-0 flex-col"
        style={{
          background: SURFACE_BG,
          color: "#e6e9ef",
          fontSize: 13,
          fontFamily:
            '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        }}
      >
        {/* Calm one-line surface header (matches the dashboard meta row tone). */}
        <div
          className="flex shrink-0 items-center gap-3 px-4 py-3"
          style={{ borderBottom: "1px solid #262d36", background: "#111318" }}
        >
          <h1 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>
            Capacity &amp; queue
          </h1>
          <span style={{ color: "#8b93a1", fontSize: 12 }}>
            What&apos;s on the plate, and what dispatches next
          </span>
          <span style={{ flex: 1 }} />
          <span
            style={{
              fontFamily:
                "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
              fontSize: 10,
              letterSpacing: 1.5,
              color: status === "connected" ? "#39d07a" : "#ef5d5d",
              border: `1px solid ${status === "connected" ? "rgba(57,208,122,0.35)" : "rgba(239,93,93,0.35)"}`,
              borderRadius: 5,
              padding: "2px 6px",
            }}
          >
            {status === "connected" ? "LIVE" : "OFFLINE"}
          </span>
        </div>

        {/* The edge-to-edge ranked depth table, filling the inset below the strip. */}
        <div className="min-h-0 flex-1">
          {payload ? (
            <QueueView data={payload} embedded />
          ) : (
            <div style={{ color: "#8b93a1", padding: 24 }}>
              Connecting to execution-core…
            </div>
          )}
        </div>
      </div>
    </TooltipProvider>
  );
}
