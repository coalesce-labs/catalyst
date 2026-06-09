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
// `mockups/home-proto/src/components/AppSidebar.tsx`. Live badges + status dots
// are MOCK now (per the ticket: "lands the frame and the OPERATE nav shell with
// mock/placeholder badges"). Wire to the unified event log
// (~/catalyst/events/YYYY-MM.jsonl) the HUD already reads in a later SHELL
// ticket — that same stream feeds worker count, queue depth, and the Board
// anomaly dot. The workspace switcher is a later SHELL slot.
//
// CTL-893 / SHELL3 — gives the rail its final shape: the brand header now uses
// the Catalyst chevron mark (`CatalystLogo`, ported from `assets/brand-v2/
// mark.svg`, inherits currentColor so it recolors per theme) with a wordmark
// that hides on icon-collapse, and the footer gains a real calm-dark ⇄ warm-light
// theme toggle wired to `@/lib/theme`'s `useTheme()` next to Settings + the
// (still MOCK) daemon-health dot.

// ── OPERATE nav — the touch-it-every-minute tier ─────────────────────────────
type OperateItem = {
  surface: Surface;
  label: string;
  icon: typeof InboxIcon;
  /** Numeric badge (active worker count / queue depth). MOCK for SHELL1. */
  badge?: number;
  /** A small status dot overlaying the icon — survives the icon-collapse. MOCK. */
  dot?: "live" | "anomaly";
};

const OPERATE: OperateItem[] = [
  { surface: "home", label: "Home", icon: InboxIcon },
  { surface: "board", label: "Board", icon: LayoutGridIcon, dot: "anomaly" },
  {
    surface: "workers",
    label: "Workers",
    icon: UsersIcon,
    badge: 4,
    dot: "live",
  },
  { surface: "queue", label: "Queue", icon: ListOrderedIcon, badge: 7 },
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

  function go(s: Surface) {
    setSurface(s);
    if (isMobile) setOpenMobile(false);
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
              {OPERATE.map((item) => (
                <SidebarMenuItem key={item.surface}>
                  <SidebarMenuButton
                    isActive={surface === item.surface}
                    tooltip={item.label}
                    onClick={() => go(item.surface)}
                  >
                    <span className="relative flex items-center justify-center">
                      <item.icon />
                      {item.dot && <StatusDot kind={item.dot} />}
                    </span>
                    <span>{item.label}</span>
                  </SidebarMenuButton>
                  {item.badge != null && (
                    <SidebarMenuBadge>{item.badge}</SidebarMenuBadge>
                  )}
                </SidebarMenuItem>
              ))}
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
            {/* daemon-health dot — emerald = daemon healthy. MOCK for SHELL1;
                wire to the event stream (~/catalyst/events/YYYY-MM.jsonl). */}
            <SidebarMenuBadge>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label="Daemon healthy"
                    className="flex size-5 cursor-default items-center justify-center"
                  >
                    <span
                      aria-hidden
                      className="size-2 rounded-full bg-emerald-500"
                    />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="right">Daemon healthy</TooltipContent>
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
