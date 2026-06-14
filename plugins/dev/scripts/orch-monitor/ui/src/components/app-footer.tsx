// app-footer.tsx — the app status bar (CTL-930 / CTL-944).
// Mounted in app-shell.tsx inside SidebarInset after the content div, so every
// surface gets it. Height ~28px, border-t, monospace 11px.
//
// Absorbs the SHELL8 sidebar footer health dots:
//   Left: LIVE/OFFLINE badge + categorical activity readout
//         (active · dead · free · waiting).
//   Right: per-node health dots with tooltips.
//
// CTL-1032: the activity summary now counts HONESTLY. It used to read a single
// `nav.workerCount` "N active" figure that lumped dead/stale background jobs in
// with genuinely-working slots. It now derives four categories from the board
// snapshot via deriveFooterCounts, which imports the SAME CTL-1015 control-tower
// classification utilities (assignSlots / deadWorkers / groupHoldingBuckets) —
// so the strip and the control tower can never disagree.
//
// The .catalyst-live-dot and .catalystLivePing animations are in app.css (Phase 4
// hoists them; until then they render without animation on non-board surfaces).
import { cn } from "@/lib/utils";
import { useBoardSnapshot } from "@/hooks/use-board-snapshot";
import { deriveFooterCounts } from "@/components/footer-counts";
// CTL-945: consume shared context from AppShell — no additional EventSources.
import { useNavSignalContext } from "@/hooks/use-nav-signal";
import { useClusterSignalContext } from "@/hooks/use-cluster-signal";
import { nodeDotClass, nodeStatusLabel } from "@/lib/cluster-signal";
import { daemonDotClass, daemonLabel } from "@/lib/nav-signal";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { C, LIVE } from "@/board/board-tokens";

export function AppFooter() {
  const { payload, status } = useBoardSnapshot();
  const nav = useNavSignalContext();
  const cluster = useClusterSignalContext();

  const isLive = status === "connected";
  // CTL-1032: derive the four honest categories from the board snapshot using the
  // shared CTL-1015 classification (dead workers excluded from active, free =
  // empty slots, waiting = admission-gate-held tickets). The board snapshot is
  // the SAME data source the control tower reads, so the numbers always agree.
  const counts = payload
    ? deriveFooterCounts(payload.workers, payload.tickets, payload.config.maxParallel)
    : null;

  return (
    <footer
      className="flex h-7 shrink-0 items-center gap-3 border-t border-border px-3"
      style={{ fontFamily: C.mono, fontSize: 11, color: C.fgMuted }}
    >
      {/* LIVE/OFFLINE badge */}
      <span
        className={cn(
          "inline-flex items-center gap-1.5 font-mono text-[10px] tracking-widest",
          isLive ? "text-green-500" : "text-red-400",
        )}
      >
        {isLive ? (
          <span
            className="catalyst-live-dot"
            style={{
              width: 6,
              height: 6,
              borderRadius: "50%",
              background: LIVE,
              display: "inline-block",
              flex: "0 0 auto",
            }}
          />
        ) : (
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: "50%",
              background: C.red,
              display: "inline-block",
              flex: "0 0 auto",
            }}
          />
        )}
        {isLive ? "LIVE" : "OFFLINE"}
      </span>

      {/* Activity summary — honest categorical readout (CTL-1032).
          active + free always render; dead + waiting collapse away when zero.
          Muted, Linear-calm: active reads in fg, the rest sit dim/muted. */}
      {counts && (
        <span className="flex items-center" style={{ gap: 0 }}>
          <span style={{ color: C.fg }}>{counts.active} active</span>
          {counts.dead > 0 && (
            <span style={{ color: C.fgDim }}>
              {" · "}
              {counts.dead} dead
            </span>
          )}
          <span style={{ color: C.fgMuted }}>
            {" · "}
            {counts.free} free
          </span>
          {counts.waiting > 0 && (
            <span style={{ color: C.fgDim }}>
              {" · "}
              {counts.waiting} waiting
            </span>
          )}
        </span>
      )}

      {/* Spacer */}
      <span className="flex-1" />

      {/* Health dots */}
      {cluster && cluster.nodes.length > 0 ? (
        <span className="flex items-center gap-1">
          {cluster.nodes.map((node) => (
            <Tooltip key={node.host}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label={nodeStatusLabel(node.host, node.status)}
                  className="flex size-4 cursor-default items-center justify-center"
                >
                  <span
                    aria-hidden
                    className={cn("size-2 rounded-full", nodeDotClass(node.status))}
                  />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top">
                {nodeStatusLabel(node.host, node.status)}
              </TooltipContent>
            </Tooltip>
          ))}
        </span>
      ) : nav ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={daemonLabel(nav.daemon)}
              className="flex size-4 cursor-default items-center justify-center"
            >
              <span
                aria-hidden
                className={cn("size-2 rounded-full", daemonDotClass(nav.daemon))}
              />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">
            {daemonLabel(nav.daemon)}
          </TooltipContent>
        </Tooltip>
      ) : (
        <span
          aria-hidden
          className="size-2 rounded-full bg-muted-foreground/40"
        />
      )}
    </footer>
  );
}
