import { useState } from "react";
import {
  ActivityIcon,
  ChevronRightIcon,
  GaugeIcon,
  InboxIcon,
  LayoutGridIcon,
  ListOrderedIcon,
  SearchIcon,
  ServerIcon,
  SettingsIcon,
  UsersIcon,
  WalletIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { useSurface, type Surface } from "@/lib/surface";
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
// anomaly dot. The workspace switcher / theme toggle are also later SHELL slots.

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
  const [observeOpen, setObserveOpen] = useState(false);

  function go(s: Surface) {
    setSurface(s);
    if (isMobile) setOpenMobile(false);
  }

  return (
    <Sidebar variant="inset" collapsible="icon">
      {/* ── HEADER: logo + ⌘K trigger ───────────────────────────────────────── */}
      <SidebarHeader className="gap-2">
        <div className="flex items-center gap-2 px-1 pt-1">
          <img
            src="/public/favicon.svg"
            alt="Catalyst"
            className="size-[22px] shrink-0 group-data-[collapsible=icon]:size-5"
          />
          <span className="text-sm font-medium tracking-tight group-data-[collapsible=icon]:hidden">
            Catalyst
          </span>
        </div>

        {/* ⌘K search trigger, styled as a muted field. Opens the command palette
            (the cmd+k handler lives in AppShell). */}
        <button
          type="button"
          data-cmdk-trigger
          className={cn(
            "flex h-8 w-full items-center gap-2 rounded-md border border-border bg-secondary/40 px-2 text-sm text-muted-foreground",
            "transition-colors hover:bg-secondary hover:text-foreground",
            "group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0",
          )}
          aria-label="Search or jump to…"
        >
          <SearchIcon className="size-4 shrink-0" />
          <span className="flex-1 text-left group-data-[collapsible=icon]:hidden">
            Search…
          </span>
          <kbd className="rounded border border-border bg-background/60 px-1 py-0.5 text-[10px] text-muted-foreground group-data-[collapsible=icon]:hidden">
            ⌘K
          </kbd>
        </button>
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

      {/* ── FOOTER: settings + daemon-health dot ────────────────────────────── */}
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
        </SidebarMenu>
      </SidebarFooter>

      {/* Click the hairline rail to collapse/expand (calls toggleSidebar). */}
      <SidebarRail />
    </Sidebar>
  );
}
