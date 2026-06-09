import { useState } from "react";
import {
  ActivityIcon,
  ChevronRightIcon,
  GaugeIcon,
  InboxIcon,
  LayoutGridIcon,
  ListOrderedIcon,
  MoonIcon,
  ServerIcon,
  SettingsIcon,
  SunIcon,
  UsersIcon,
  WalletIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { useSurface, type Surface } from "@/lib/surface";
import { useTheme } from "@/lib/theme";
import { useNavSignal } from "@/hooks/use-nav-signal";
import { daemonDotClass, daemonLabel } from "@/lib/nav-signal";
import { CatalystLogo } from "@/components/catalyst-logo";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar";

// CTL-891 / SHELL1 — the OPERATE/OBSERVE left nav, ported from the prototype
// `mockups/home-proto/src/components/AppSidebar.tsx`.
//
// CTL-893 / SHELL3 — gives the rail its final shape: the brand header now uses
// the Catalyst chevron mark (`CatalystLogo`, ported from `assets/brand-v2/
// mark.svg`, inherits currentColor so it recolors per theme) with a wordmark
// that hides on icon-collapse, and the footer gains a real calm-dark ⇄ warm-light
// theme toggle wired to `@/lib/theme`'s `useTheme()` next to Settings.
//
// CTL-896 / SHELL6 — the live signal that is the whole payoff of a vertical rail.
// The Workers active-count badge, the Queue depth badge, the Board anomaly dot,
// and the footer daemon-health dot are NO LONGER MOCK: they are fed by the read-
// model's dedicated nav-signal projection over SSE (`useNavSignal` →
// `/api/nav/stream`), the SAME push model the board uses — never a per-tab tail
// of the source files. The OPERATE array below carries only the static IA
// (surface/label/icon); the badge/dot for each item is DERIVED per-render from
// the live signal in this component. The workspace switcher is a later SHELL slot.

// ── OPERATE nav — the touch-it-every-minute tier ─────────────────────────────
type OperateItem = {
  surface: Surface;
  label: string;
  icon: typeof InboxIcon;
};

// The OPERATE array carries ONLY the static IA (surface/label/icon). Every
// badge/dot is DERIVED per-render from the live nav signal (CTL-896 / SHELL6) —
// including the Queue depth badge that CTL-910 / SURF2 introduced (now fed by the
// read-model nav-signal projection `nav.queueDepth` instead of a second snapshot
// subscription). No mock literals here.
const OPERATE: OperateItem[] = [
  { surface: "home", label: "Home", icon: InboxIcon },
  { surface: "board", label: "Board", icon: LayoutGridIcon },
  { surface: "workers", label: "Workers", icon: UsersIcon },
  { surface: "queue", label: "Queue", icon: ListOrderedIcon },
];

// ── OBSERVE — the "go deeper" tier, ships now, items land over time ───────────
const OBSERVE = [
  { label: "Telemetry", icon: ActivityIcon },
  { label: "Utilization", icon: GaugeIcon },
  { label: "FinOps", icon: WalletIcon },
  { label: "Fleet Ops", icon: ServerIcon },
] as const;

/** A status dot overlaid on a nav icon (emerald = live, amber = anomaly). */
function StatusDot({ kind }: { kind: "live" | "anomaly" }) {
  return (
    <span
      aria-hidden
      className={cn(
        "pointer-events-none absolute -top-0.5 -right-0.5 size-2 rounded-full ring-2 ring-sidebar",
        kind === "live" ? "bg-emerald-500" : "bg-amber-500",
      )}
    />
  );
}

export function AppSidebar() {
  const { surface, setSurface } = useSurface();
  const { setOpenMobile, isMobile } = useSidebar();
  const { theme, toggle: toggleTheme } = useTheme();
  const [observeOpen, setObserveOpen] = useState(false);
  // CTL-896 / SHELL6 — the live nav signal off the read-model SSE projection.
  // null until the first frame lands; the badges/dots simply don't render until
  // then (no mock placeholder), then go live and update without a page reload.
  // This supersedes CTL-910 / SURF2's separate useBoardSnapshot queue-depth
  // badge: the Queue depth is now `nav.queueDepth` from the SAME projection.
  const nav = useNavSignal();

  function go(s: Surface) {
    setSurface(s);
    if (isMobile) setOpenMobile(false);
  }

  // Derive the live badge + dot for an OPERATE item from the nav signal. Workers
  // shows the active count + an emerald live dot when any worker is running;
  // Queue shows its depth; Board shows an amber anomaly dot when the read-model
  // reports a blocked/needs-human/stuck anomaly. Home carries no live signal.
  function liveBadge(s: Surface): number | null {
    if (!nav) return null;
    if (s === "workers") return nav.workerCount;
    if (s === "queue") return nav.queueDepth;
    return null;
  }
  function liveDot(s: Surface): "live" | "anomaly" | null {
    if (!nav) return null;
    if (s === "workers") return nav.workerCount > 0 ? "live" : null;
    if (s === "board") return nav.anomaly ? "anomaly" : null;
    return null;
  }

  return (
    // CTL-894 / SHELL4 — headline collapse is full↔HIDDEN ("offcanvas"): collapsed
    // slides the whole rail off-screen so the active surface goes truly full-bleed
    // and reclaims the ENTIRE nav width (Board gains a full lane; Home re-centers),
    // per app-shell research §3. The `collapsible="icon"` icon-rail middle state is
    // an explicit later nicety, not the v1 emphasis; the `group-data-[collapsible=
    // icon]:…` classes below stay as inert documentation of that optional mode.
    <Sidebar variant="inset" collapsible="offcanvas">
      {/* ── HEADER: chevron mark + wordmark ─────────────────────────────────── */}
      {/* CTL-895 / SHELL5 — the redundant sidebar-header search field was REMOVED
          here (handoff cosmetic #1: the prototype shipped TWO ⌘K triggers, one in
          this header and one in the top strip). Search now lives in EXACTLY one
          place — the top-strip ⌘K trigger (app-shell.tsx) — plus the ⌘K / `/`
          keyboard openers. Keep the header to the brand only. */}
      <SidebarHeader className="gap-2">
        <div className="flex items-center gap-2 px-1 pt-1">
          {/* The chevron mark stays at every collapse width; only the wordmark
              hides on icon-collapse (Gherkin: "only the Catalyst chevron mark
              remains"). currentColor → it recolors with the calm-dark/warm-light
              theme for free. */}
          <CatalystLogo className="size-[22px] text-foreground group-data-[collapsible=icon]:size-5" />
          <span className="text-sm font-medium tracking-tight group-data-[collapsible=icon]:hidden">
            Catalyst
          </span>
        </div>
      </SidebarHeader>

      <SidebarContent>
        {/* ── OPERATE — always expanded, the primary tier ─────────────────── */}
        <SidebarGroup>
          <SidebarGroupLabel>Operate</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {OPERATE.map((item) => {
                const dot = liveDot(item.surface);
                const badge = liveBadge(item.surface);
                return (
                  <SidebarMenuItem key={item.surface}>
                    <SidebarMenuButton
                      isActive={surface === item.surface}
                      tooltip={item.label}
                      onClick={() => go(item.surface)}
                    >
                      <span className="relative flex items-center justify-center">
                        <item.icon />
                        {dot && <StatusDot kind={dot} />}
                      </span>
                      <span>{item.label}</span>
                    </SidebarMenuButton>
                    {badge != null && (
                      <SidebarMenuBadge>{badge}</SidebarMenuBadge>
                    )}
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {/* ── OBSERVE — collapsible, defaults collapsed, "soon" items ──────── */}
        <Collapsible
          open={observeOpen}
          onOpenChange={setObserveOpen}
          className="group/observe"
        >
          <SidebarGroup>
            {/* Trigger styled to MATCH SidebarGroupLabel, kept as a plain
                interactive CollapsibleTrigger <button>. */}
            <CollapsibleTrigger
              className={cn(
                "flex h-8 w-full shrink-0 items-center rounded-md px-2 text-xs font-medium text-sidebar-foreground/70 outline-hidden transition-[margin,opacity,color] duration-200 ease-linear",
                "cursor-pointer hover:text-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring",
                "group-data-[collapsible=icon]:-mt-8 group-data-[collapsible=icon]:opacity-0",
              )}
            >
              <ChevronRightIcon className="mr-1 size-3.5 transition-transform duration-200 group-data-[state=open]/observe:rotate-90" />
              Observe
            </CollapsibleTrigger>
            <CollapsibleContent>
              <SidebarGroupContent>
                <SidebarMenu>
                  {OBSERVE.map((item) => (
                    <SidebarMenuItem key={item.label}>
                      <SidebarMenuButton
                        disabled
                        tooltip={`${item.label} — coming soon`}
                        className="cursor-not-allowed opacity-55"
                      >
                        <item.icon />
                        <span>{item.label}</span>
                      </SidebarMenuButton>
                      <SidebarMenuBadge className="text-[10px] text-muted-foreground/70">
                        soon
                      </SidebarMenuBadge>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </CollapsibleContent>
          </SidebarGroup>
        </Collapsible>
      </SidebarContent>

      {/* ── FOOTER: settings + theme toggle + daemon-health dot ─────────────── */}
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton tooltip="Settings">
              <SettingsIcon />
              <span>Settings</span>
            </SidebarMenuButton>
            {/* CTL-896 / SHELL6 — daemon-health dot wired to the read-model's
                local-node liveness (the single-host identity no-op: the one local
                daemon's own node.heartbeat freshness). Emerald = healthy, amber =
                degraded, red = offline. The cyan #5be0ff live-signal color is
                RESERVED and deliberately not used here. Until the first nav frame
                lands `nav` is null → an unknown (muted) dot, never a fake green. */}
            <SidebarMenuBadge>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label={
                      nav ? daemonLabel(nav.daemon) : "Daemon health unknown"
                    }
                    className="flex size-5 cursor-default items-center justify-center"
                  >
                    <span
                      aria-hidden
                      className={cn(
                        "size-2 rounded-full",
                        nav ? daemonDotClass(nav.daemon) : "bg-muted-foreground/40",
                      )}
                    />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="right">
                  {nav ? daemonLabel(nav.daemon) : "Daemon health unknown"}
                </TooltipContent>
              </Tooltip>
            </SidebarMenuBadge>
          </SidebarMenuItem>

          {/* CTL-893 / SHELL3 — calm-dark ⇄ warm-light theme toggle. Stays
              reachable at every collapse width (the icon is always shown; the
              label hides on icon-collapse like every other SidebarMenuButton).
              Wired to the real theme system (`useTheme`), not re-implemented. */}
          <SidebarMenuItem>
            <SidebarMenuButton
              onClick={toggleTheme}
              tooltip={
                theme === "dark" ? "Switch to warm light" : "Switch to calm dark"
              }
              aria-label={
                theme === "dark" ? "Switch to warm light" : "Switch to calm dark"
              }
            >
              {theme === "dark" ? <SunIcon /> : <MoonIcon />}
              <span>{theme === "dark" ? "Warm light" : "Calm dark"}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>

      {/* Click the hairline rail to collapse/expand (calls toggleSidebar). */}
      <SidebarRail />
    </Sidebar>
  );
}
