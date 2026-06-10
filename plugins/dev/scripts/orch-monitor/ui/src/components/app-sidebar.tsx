import { useEffect, useState } from "react";
import { useAtom } from "jotai";
import {
  ActivityIcon,
  ChevronRightIcon,
  CodeIcon,
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
// CTL-945: consume shared context from AppShell — no additional EventSources.
import { useNavSignalContext } from "@/hooks/use-nav-signal";
// CTL-898 / SHELL8 — the footer health dot generalizes into a per-node cluster-
// health indicator + a node filter, fed by the read-model's cluster-signal
// projection. Single-host is an exact no-op (one dot, no filter).
import { useClusterSignalContext } from "@/hooks/use-cluster-signal";
import {
  nodeDotClass,
  shouldShowNodeFilter,
} from "@/lib/cluster-signal";
import { ALL_NODES, resolveNodeScope, useNodeScope } from "@/lib/node-scope";
import { CatalystLogo } from "@/components/catalyst-logo";
import { buildNavGroups } from "@/lib/nav-model";
import { repoScopeAtom, navGroupsOpenAtom } from "@/board/nav-store";
import { useBoardSnapshot } from "@/hooks/use-board-snapshot";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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

// CTL-891 / SHELL1 — the OPERATE/OBSERVE left nav.
// CTL-893 / SHELL3 — final rail shape: brand header + theme toggle.
// CTL-896 / SHELL6 — live signal badges from nav-signal projection.
// CTL-898 / SHELL8 — per-node cluster-health dots.
// CTL-930 / CTL-944 — project-grouped nav: Overall flat + one Collapsible per repo + Observe last.

/** A status dot overlaid on a nav icon (emerald = live, amber = anomaly). */
function StatusDot({ kind }: { kind: "live" | "anomaly" }) {
  return (
    <span
      aria-hidden
      className={cn(
        "pointer-events-none absolute -top-0.5 -right-0.5 size-2 rounded-full ring-2 ring-sidebar",
        kind === "live" ? "bg-green" : "bg-yellow",
      )}
    />
  );
}

// ── OBSERVE — disabled "soon" items ──────────────────────────────────────────
const OBSERVE = [
  { label: "Telemetry", icon: ActivityIcon },
  { label: "Utilization", icon: GaugeIcon },
  { label: "FinOps", icon: WalletIcon },
  { label: "Fleet Ops", icon: ServerIcon },
  { label: "DevOps", icon: CodeIcon },
] as const;

// ── OPERATE items per scope ───────────────────────────────────────────────────
const OPERATE_ITEMS: Array<{ surface: Surface; label: string; icon: typeof InboxIcon }> = [
  { surface: "home", label: "Inbox", icon: InboxIcon },
  { surface: "board", label: "Tickets", icon: LayoutGridIcon },
  { surface: "workers", label: "Workers", icon: UsersIcon },
  { surface: "queue", label: "Queue", icon: ListOrderedIcon },
];

export function AppSidebar() {
  // CTL-911 / SURF3 — settingsOpen/openSettings drive the footer Settings item.
  const { surface, setSurface, settingsOpen, openSettings } = useSurface();
  const { setOpenMobile, isMobile } = useSidebar();
  const { theme, toggle: toggleTheme } = useTheme();
  const [observeOpen, setObserveOpen] = useState(false);
  // CTL-945: consume from AppShell's shared contexts — no new EventSources opened.
  // CTL-896 / SHELL6 — the live nav signal off the read-model SSE projection.
  const nav = useNavSignalContext();
  // CTL-898 / SHELL8 — the live PER-NODE cluster-health signal.
  const cluster = useClusterSignalContext();
  const { scope, setScope } = useNodeScope();
  const showNodeFilter = shouldShowNodeFilter(cluster);

  // CTL-944 — the active repo scope and per-group open state.
  const [repoScope, setRepoScope] = useAtom(repoScopeAtom);
  const [groupsOpen, setGroupsOpen] = useAtom(navGroupsOpenAtom);

  // Get repos from the board snapshot for nav group construction.
  const { payload } = useBoardSnapshot();
  const repos = payload?.repos ?? [];

  // Repo colors from the nav signal (if available) or empty.
  const repoColors: Record<string, { text: string }> = {};
  // Build nav groups dynamically from live repos.
  const navGroups = buildNavGroups(repos, repoColors);

  // CTL-898 / SHELL8 — a node going dark must not strand the operator.
  useEffect(() => {
    if (scope === ALL_NODES || !cluster) return;
    const roster = cluster.singleHost ? [] : cluster.nodes.map((n) => n.host);
    const resolved = resolveNodeScope(scope, roster);
    if (resolved !== scope) setScope(resolved);
  }, [cluster, scope, setScope]);

  function go(s: Surface, scopeVal?: string) {
    setSurface(s);
    if (scopeVal !== undefined) setRepoScope(scopeVal);
    if (isMobile) setOpenMobile(false);
  }

  // Derive badge for an OPERATE item from the nav signal.
  function liveBadge(s: Surface, scopeVal: string): number | null {
    if (!nav) return null;
    if (s === "workers") {
      if (scopeVal === "all") return nav.workerCount;
      return null; // per-project count requires BFF projection (future)
    }
    if (s === "queue") {
      if (scopeVal === "all") return nav.queueDepth;
      return null;
    }
    return null;
  }
  function liveDot(s: Surface): "live" | "anomaly" | null {
    if (!nav) return null;
    if (s === "workers") return nav.workerCount > 0 ? "live" : null;
    if (s === "board") return nav.anomaly ? "anomaly" : null;
    return null;
  }

  // Check if a nav item is active (surface AND scope match).
  function isItemActive(s: Surface, scopeVal: string): boolean {
    return surface === s && repoScope === scopeVal;
  }

  // Render a single OPERATE item (used in both Overall and per-project groups).
  function renderOperateItem(
    item: (typeof OPERATE_ITEMS)[number],
    scopeVal: string,
  ) {
    const dot = liveDot(item.surface);
    const badge = liveBadge(item.surface, scopeVal);
    const active = isItemActive(item.surface, scopeVal);
    return (
      <SidebarMenuItem key={`${scopeVal}:${item.surface}`}>
        <SidebarMenuButton
          isActive={active}
          tooltip={item.label}
          onClick={() => go(item.surface, scopeVal)}
        >
          <span className="relative flex items-center justify-center">
            <item.icon />
            {dot && scopeVal === "all" && <StatusDot kind={dot} />}
          </span>
          <span>{item.label}</span>
        </SidebarMenuButton>
        {badge != null && (
          <SidebarMenuBadge>{badge}</SidebarMenuBadge>
        )}
      </SidebarMenuItem>
    );
  }

  // Whether a per-project group contains the active item (force-open).
  function groupContainsActive(groupScope: string): boolean {
    return repoScope === groupScope || OPERATE_ITEMS.some(
      (item) => isItemActive(item.surface, groupScope),
    );
  }

  return (
    <Sidebar variant="inset" collapsible="offcanvas">
      {/* ── HEADER: chevron mark + wordmark ─────────────────────────────────── */}
      <SidebarHeader className="gap-2">
        <div className="flex items-center gap-2 px-1 pt-1">
          <CatalystLogo className="size-[22px] text-foreground group-data-[collapsible=icon]:size-5" />
          <span className="text-sm font-medium tracking-tight group-data-[collapsible=icon]:hidden">
            Catalyst
          </span>
        </div>
        {/* CTL-930: WorkspaceSwitcher removed from sidebar header. Scope is now
            communicated by clicking the per-project group items directly. */}
      </SidebarHeader>

      <SidebarContent>
        {/* ── OVERALL: flat always-expanded group (scope = "all") ──────────── */}
        <SidebarGroup>
          <SidebarGroupLabel>Operate</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {OPERATE_ITEMS.map((item) => renderOperateItem(item, "all"))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {/* ── PER-PROJECT GROUPS: one collapsible per repo ────────────────── */}
        {repos.map((repo) => {
          // navGroups has the per-repo group; get its dotColor
          const navGroup = navGroups.find((g) => g.scope === repo);
          const dotColor = navGroup?.dotColor;
          // Force-open when this group contains the active item.
          const forceOpen = groupContainsActive(repo);
          const isOpen = forceOpen || (groupsOpen[repo] ?? true); // default open
          return (
            <Collapsible
              key={repo}
              open={isOpen}
              onOpenChange={(open) => {
                if (!forceOpen) {
                  setGroupsOpen((prev) => ({ ...prev, [repo]: open }));
                }
              }}
              className={`group/${repo.replace(/[^a-z0-9]/gi, "_")}`}
            >
              <SidebarGroup>
                <CollapsibleTrigger
                  className={cn(
                    "flex h-8 w-full shrink-0 items-center rounded-md px-2 text-xs font-medium text-sidebar-foreground/70 outline-hidden transition-[margin,opacity,color] duration-200 ease-linear",
                    "cursor-pointer hover:text-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring",
                    "group-data-[collapsible=icon]:-mt-8 group-data-[collapsible=icon]:opacity-0",
                  )}
                >
                  <ChevronRightIcon
                    className="mr-1 size-3.5 transition-transform duration-200"
                    style={{ transform: isOpen ? "rotate(90deg)" : undefined }}
                  />
                  {dotColor && (
                    <span
                      aria-hidden
                      className="mr-1.5 size-2 rounded-full flex-shrink-0 inline-block"
                      style={{ background: dotColor }}
                    />
                  )}
                  {repo}
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <SidebarGroupContent>
                    <SidebarMenu>
                      {OPERATE_ITEMS.map((item) => renderOperateItem(item, repo))}
                    </SidebarMenu>
                  </SidebarGroupContent>
                </CollapsibleContent>
              </SidebarGroup>
            </Collapsible>
          );
        })}

        {/* ── OBSERVE — collapsible, defaults collapsed, "soon" items ──────── */}
        <Collapsible
          open={observeOpen}
          onOpenChange={setObserveOpen}
          className="group/observe"
        >
          <SidebarGroup>
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

      {/* ── FOOTER: node filter + settings + theme toggle ─────────────────── */}
      {/* CTL-930: health dots MOVED to AppFooter (app-footer.tsx). This footer
          keeps node filter, Settings, and theme toggle only. */}
      <SidebarFooter>
        <SidebarMenu>
          {/* CTL-898 / SHELL8 — the NODE FILTER. */}
          {showNodeFilter && (
            <SidebarMenuItem>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <SidebarMenuButton
                    tooltip="Focus a node"
                    aria-label={
                      scope === ALL_NODES ? "All nodes" : `Node: ${scope}`
                    }
                  >
                    <ServerIcon />
                    <span>
                      {scope === ALL_NODES ? "All nodes" : scope}
                    </span>
                  </SidebarMenuButton>
                </DropdownMenuTrigger>
                <DropdownMenuContent side="right" align="end" className="min-w-44">
                  <DropdownMenuLabel>Focus a node</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuRadioGroup
                    value={scope}
                    onValueChange={(v) => setScope(v)}
                  >
                    <DropdownMenuRadioItem value={ALL_NODES}>
                      All nodes
                    </DropdownMenuRadioItem>
                    {cluster?.nodes.map((node) => (
                      <DropdownMenuRadioItem key={node.host} value={node.host}>
                        <span className="flex items-center gap-2">
                          <span
                            aria-hidden
                            className={cn(
                              "size-2 rounded-full",
                              nodeDotClass(node.status),
                            )}
                          />
                          {node.host}
                        </span>
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            </SidebarMenuItem>
          )}

          <SidebarMenuItem>
            <SidebarMenuButton
              tooltip="Settings"
              isActive={settingsOpen}
              onClick={() => {
                openSettings();
                if (isMobile) setOpenMobile(false);
              }}
            >
              <SettingsIcon />
              <span>Settings</span>
            </SidebarMenuButton>
          </SidebarMenuItem>

          {/* CTL-893 / SHELL3 — calm-dark ⇄ warm-light theme toggle. */}
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

      <SidebarRail />
    </Sidebar>
  );
}
