// app-footer.tsx — the app status bar (CTL-930 / CTL-944).
// Mounted in app-shell.tsx inside SidebarInset after the content div, so every
// surface gets it. Height ~28px, border-t, monospace 11px.
//
// Absorbs the SHELL8 sidebar footer health dots:
//   Left: LIVE/OFFLINE badge + activity summary (active · stuck · queued).
//   Right: per-node health dots with tooltips.
//
// The .catalyst-live-dot and .catalystLivePing animations are in app.css (Phase 4
// hoists them; until then they render without animation on non-board surfaces).
import { cn } from "@/lib/utils";
import { useBoardSnapshot } from "@/hooks/use-board-snapshot";
import { useNavSignal } from "@/hooks/use-nav-signal";
import { useClusterSignal } from "@/hooks/use-cluster-signal";
import { nodeDotClass, nodeStatusLabel } from "@/lib/cluster-signal";
import { daemonDotClass, daemonLabel } from "@/lib/nav-signal";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { C, LIVE } from "@/board/board-tokens";

export function AppFooter() {
  const { status } = useBoardSnapshot();
  const nav = useNavSignal();
  const cluster = useClusterSignal();

  const isLive = status === "connected";
  const config = nav ? { active: nav.workerCount, stuck: 0, queued: nav.queueDepth } : null;

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

      {/* Activity summary */}
      {config && (
        <span className="flex items-center gap-1">
          <span style={{ color: C.fg }}>{config.active} active</span>
          {config.stuck > 0 && (
            <span style={{ color: C.red }}> · {config.stuck} stuck</span>
          )}
          {config.queued > 0 && (
            <span style={{ color: C.fgDim }}> · {config.queued} queued</span>
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
