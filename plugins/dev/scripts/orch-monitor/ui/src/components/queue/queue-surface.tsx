// queue-surface.tsx — the /queue CONTROL TOWER (CTL-1015 rebuild of CTL-910/SURF2).
//
// This is a rebuild of the body, not a restyle of the table. The page answers
// "what consumes capacity next?" — a fleet-of-workers, departure-board surface in
// the Linear-calm idiom. It keeps the SURF2 shell contract (the same cache-backed
// read-model snapshot the board + Inbox consume, NEVER a synchronous Linear call)
// and the existing surface header bar; only the subtitle copy changed.
//
// The body is composed from four presentational sections — SlotDeck (hero),
// DispatchQueue, HoldingBuckets, DeadStrip — plus a rank footer. Each takes plain
// data props (no snapshot hook, no router), so CTL-1016's Workers surface can
// mount SlotDeck + DeadStrip directly with its own payload slice.
import { useCallback } from "react";
import { useNavigate } from "@tanstack/react-router";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useScopedBoardSnapshot } from "@/hooks/use-scoped-board-snapshot";
import { C } from "../../board/board-tokens";
import { queueHostMode } from "../../board/queue-grouping";
import { SlotDeck } from "./slot-deck";
import { DispatchQueue } from "./dispatch-queue";
import { HoldingBuckets } from "./holding-buckets";
import { DeadStrip } from "./dead-strip";

export function QueueSurface() {
  const { payload, status } = useScopedBoardSnapshot();
  const navigate = useNavigate();

  // The surface owns routing (the sections stay router-free for composability):
  // open a ticket detail page via the shared /ticket/$id route.
  const onOpenTicket = useCallback(
    (key: string) => {
      void navigate({ to: "/ticket/$id", params: { id: key } });
    },
    [navigate],
  );

  const multiHost = payload ? queueHostMode(payload.queue) === "multi" : false;

  return (
    <TooltipProvider delayDuration={200}>
      <div
        className="flex h-full min-h-0 flex-col bg-surface-canvas text-fg"
        style={{
          fontSize: 13,
          fontFamily:
            '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        }}
      >
        {/* Calm one-line surface header (matches the dashboard meta row tone).
            CTL-1033: content shell = canvas (not chrome); hairline via border-subtle. */}
        <div
          className="flex shrink-0 items-center gap-3 border-b border-subtle bg-surface-canvas px-4 py-3"
        >
          <h1 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>
            Capacity &amp; queue
          </h1>
          <span style={{ color: "#8b93a1", fontSize: 12 }}>
            Who&apos;s working each slot, and what dispatches next
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

        {/* The control-tower body, filling the inset below the header. */}
        <div className="cat-scroll min-h-0 flex-1" style={{ overflowY: "auto" }}>
          {payload ? (
            <div style={{ maxWidth: 1120, margin: "0 auto", padding: "8px 24px 32px", display: "flex", flexDirection: "column", gap: 28 }}>
              <SlotDeck
                workers={payload.workers}
                tickets={payload.tickets}
                config={payload.config}
                onOpenTicket={onOpenTicket}
              />
              <DispatchQueue
                queue={payload.queue}
                freeSlots={payload.config.freeSlots}
                onOpenTicket={onOpenTicket}
              />
              <HoldingBuckets
                tickets={payload.tickets}
                workers={payload.workers}
                maxParallel={payload.config.maxParallel}
                onOpenTicket={onOpenTicket}
              />
              <DeadStrip
                workers={payload.workers}
                tickets={payload.tickets}
                maxParallel={payload.config.maxParallel}
              />
              <div style={{ fontSize: 11, color: C.fgDim }}>
                Dispatch order: priority → pipeline stage → created → id — the same rank the scheduler uses. Per-project caps apply at dispatch time. Blocked work never enters this line.
                {multiHost ? " Node = the HRW owner host for each queued ticket." : ""}
              </div>
            </div>
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
