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
import { nodeStatusLabel } from "@/lib/cluster-signal";
import { daemonLabel } from "@/lib/nav-signal";
// CTL-1172: shared service-health context + fold helper for the right indicator.
import { useServiceHealthContext } from "@/hooks/use-service-health";
import {
  worstSeverity,
  severityDotColor,
  severityDotGlow,
  severityDotOpacity,
  isLabelMuted,
  type ServiceSeverity,
} from "@/components/observe/service-health-kit";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { C, LIVE } from "@/board/board-tokens";

const RIGHT_LABEL: Record<ServiceSeverity, string> = {
  up: "HEALTHY",
  degraded: "DEGRADED",
  down: "DOWN",
  unknown: "SERVICES ?",
};

export function AppFooter() {
  const { payload, status } = useBoardSnapshot();
  const nav = useNavSignalContext();
  const cluster = useClusterSignalContext();
  const { services, unavailable } = useServiceHealthContext();

  const isLive = status === "connected";

  // CTL-1172: fold node + daemon + service health into one right indicator.
  const worst = worstSeverity({
    services,
    unavailable,
    nodeStatuses: cluster?.nodes.map((n) => n.status),
    daemonHealth: nav?.daemon ?? null,
  });
  const label = RIGHT_LABEL[worst];
  const muted = isLabelMuted(worst);
  const tooltipLines: string[] = unavailable
    ? ["Service health unavailable"]
    : (() => {
        const out: string[] = [];
        for (const s of services ?? []) {
          if (s.severity === "down" || s.severity === "degraded") {
            out.push(`${s.label} ${s.severity}`);
          }
        }
        for (const n of cluster?.nodes ?? []) {
          if (n.status === "offline" || n.status === "degraded") {
            out.push(nodeStatusLabel(n.host, n.status));
          }
        }
        if (nav && nav.daemon !== "healthy") out.push(daemonLabel(nav.daemon));
        return out.length > 0 ? out : ["All services healthy"];
      })();
  const tooltipText = tooltipLines.join("\n");
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

      {/* CTL-1172: overall fleet-health indicator — dot + label + tooltip */}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={`Service health: ${label}`}
            className="inline-flex cursor-default items-center gap-1.5 font-mono text-[10px] tracking-widest"
            style={{ color: muted ? C.fgMuted : C.fg }}
          >
            <span
              aria-hidden
              style={{
                width: 6,
                height: 6,
                borderRadius: "50%",
                background: severityDotColor(worst),
                boxShadow: severityDotGlow(worst),
                opacity: severityDotOpacity(worst),
                display: "inline-block",
                flex: "0 0 auto",
              }}
            />
            {label}
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" className="whitespace-pre-line">
          {tooltipText}
        </TooltipContent>
      </Tooltip>
    </footer>
  );
}
