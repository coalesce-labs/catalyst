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
// CTL-961: per-project icon auto-detection (favicon from GitHub) + manual override.
import { useRepoIcons } from "@/hooks/use-repo-icons";
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
// CTL-960 — left-nav polish: project-group headers, consistent twistie, Overall label.
// CTL-977 — left-nav restyle v2: natural-case headers, quieter labels, rebalanced icon/label,
//            Linear-style selected state, twistie moved to right.
// CTL-980 — nav proportion v3: icons 16px (size-4), muted inactive labels, icon color = label
//            color via currentColor, twistie beside label (not far-right), "Projects" heading.
// CTL-981 — nav final calibration: inactive label weight 400→500 (font-medium) + contrast /60→/72
//            so labels have body/presence and stop reading thin/small vs Linear's lch(60) baseline.

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

// ── OBSERVE — live items (clickable surfaces) ────────────────────────────────
// OBS-5: Telemetry is the first OBSERVE surface to ship a real content shell.
// OBS-10: FinOps is the second — the dollar+ROI hero + spend-over-time bars.
// OBS-16: Utilization is the third — the slot-occupancy hero + STARVED/JAMMED
// pathology badge + idle list + 429 + active-time. All clickable nav items; the
// remaining two stay disabled "soon" until their own OBS tickets land.
const OBSERVE_LIVE: Array<{ surface: Surface; label: string; icon: typeof InboxIcon }> = [
  { surface: "telemetry", label: "Telemetry", icon: ActivityIcon },
  { surface: "utilization", label: "Utilization", icon: GaugeIcon },
  { surface: "finops", label: "FinOps", icon: WalletIcon },
];

// ── OBSERVE — disabled "soon" items ──────────────────────────────────────────
const OBSERVE_SOON = [
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

// CTL-977: Shared classes for collapsible group trigger rows.
// Natural-case (no uppercase), quiet/muted color.
// CTL-980: twistie is placed BESIDE the label text (no ml-auto), favicon LEFT of label.
const GROUP_TRIGGER_BASE = cn(
  "flex h-7 w-full shrink-0 items-center rounded-md px-2 outline-hidden",
  // CTL-977/CTL-980: no uppercase — render names in their natural case; muted color.
  "text-[11px] font-medium text-sidebar-foreground/45",
  "transition-[margin,opacity,color] duration-200 ease-linear",
  "cursor-pointer hover:text-sidebar-foreground/70 focus-visible:ring-2 focus-visible:ring-sidebar-ring",
  "group-data-[collapsible=icon]:-mt-8 group-data-[collapsible=icon]:opacity-0",
);

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

  // CTL-961: auto-detect repo favicons from GitHub + manual overrides.
  const repoIconMap = useRepoIcons(repos);
  // Map to the simple repoKey → dataUrl shape that buildNavGroups expects.
  const repoIconDataUrls: Record<string, string | null> = {};
  for (const repo of repos) {
    repoIconDataUrls[repo] = repoIconMap[repo]?.autoDataUrl ?? null;
  }

  // Repo colors from the nav signal (if available) or empty.
  const repoColors: Record<string, { text: string }> = {};
  // Build nav groups dynamically from live repos.
  const navGroups = buildNavGroups(repos, repoColors, repoIconDataUrls);

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

  // OBS-5: force the OBSERVE group open while a live OBSERVE surface is active.
  const observeContainsActive = OBSERVE_LIVE.some(
    (item) => item.surface === surface,
  );

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
  // CTL-960: compact=true for per-project sub-items — smaller size reduces visual
  // monotony from four repeated blocks of identical Inbox/Tickets/Workers/Queue.
  // CTL-977: active item gets sidebar-primary (accent) color on icon + label text,
  // providing a clear Linear-style selected state beyond the bg fill.
  // CTL-980: icon size forced to 16px (size-4) so it reads as ~same size as the 13px
  // label (not 1.7× bigger). Icon color = currentColor so it inherits the label's
  // muted-inactive / bright-active tone automatically. Inactive labels muted to /60.
  // CTL-981: inactive weight → 500 (font-medium) + contrast /60 → /72 so labels
  // have body/presence; active stays full-brightness (text-sidebar-primary) so the
  // selection delta is still clearly visible.
  function renderOperateItem(
    item: (typeof OPERATE_ITEMS)[number],
    scopeVal: string,
    compact = false,
  ) {
    const dot = liveDot(item.surface);
    const badge = liveBadge(item.surface, scopeVal);
    const active = isItemActive(item.surface, scopeVal);
    return (
      <SidebarMenuItem key={`${scopeVal}:${item.surface}`}>
        <SidebarMenuButton
          isActive={active}
          tooltip={item.label}
          size={compact ? "sm" : "default"}
          onClick={() => go(item.surface, scopeVal)}
          // CTL-981: inactive = font-medium (weight 500) + text-sidebar-foreground/72
          // (raised from /60 for better label presence — matches Linear's lch(60) gray);
          // active = text-sidebar-primary (full accent, clearly brighter than /72).
          className={cn(
            active
              ? "text-sidebar-primary"
              : "font-medium text-sidebar-foreground/72 hover:text-sidebar-foreground",
          )}
        >
          {/* CTL-980: explicit size-4 because the icon is inside a <span> wrapper
              (for the status dot overlay), so the SidebarMenuButton's [&>svg]:size-4
              selector does NOT reach the nested SVG. Force it here. Icon uses
              currentColor — inherits the button's muted/active text color. */}
          <span className="relative flex shrink-0 items-center justify-center">
            <item.icon className="size-4 shrink-0" />
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
        {/* CTL-960: "Operate" renamed to "Overall" — single term for the all-projects
            scope consistent with the breadcrumb label from breadcrumbFor("*", "all"). */}
        {/* CTL-977: SidebarGroupLabel renders with natural case; the shadcn label
            component already uses muted/small styling — no custom overrides needed. */}
        <SidebarGroup>
          <SidebarGroupLabel>Overall</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {OPERATE_ITEMS.map((item) => renderOperateItem(item, "all"))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {/* ── PER-PROJECT GROUPS: one collapsible per repo ────────────────── */}
        {/* CTL-980: "Projects" / "Your projects" section heading above the collapsible
            project rows — mirrors Linear's "Your teams" parent section label. Only
            render the heading when there is at least one project to show. */}
        {repos.length > 0 && (
          <SidebarGroup className="pt-0 pb-0">
            <SidebarGroupLabel>Projects</SidebarGroupLabel>
          </SidebarGroup>
        )}
        {/* CTL-977: natural-case repo name, favicon stays LEFT of the label.
            CTL-980: twistie is now BESIDE the label (no ml-auto), placed right
            after the label text with a small gap, so the row reads "adva ⌄". */}
        {repos.map((repo) => {
          // navGroups has the per-repo group; get its dotColor + iconDataUrl (CTL-961)
          const navGroup = navGroups.find((g) => g.scope === repo);
          const dotColor = navGroup?.dotColor;
          // CTL-961: show auto-detected favicon if available; otherwise fall back to dot.
          const iconDataUrl = navGroup?.iconDataUrl ?? null;
          // Force-open when this group contains the active item.
          const forceOpen = groupContainsActive(repo);
          const isOpen = forceOpen || (groupsOpen[repo] ?? true); // default open
          const groupKey = repo.replace(/[^a-z0-9]/gi, "_");
          return (
            <Collapsible
              key={repo}
              open={isOpen}
              onOpenChange={(open) => {
                if (!forceOpen) {
                  setGroupsOpen((prev) => ({ ...prev, [repo]: open }));
                }
              }}
              className={`group/${groupKey}`}
            >
              <SidebarGroup className="pt-0">
                <CollapsibleTrigger className={GROUP_TRIGGER_BASE}>
                  {/* CTL-961: favicon takes priority over the color dot; only show dot
                      when no favicon is available. Never show a placeholder. */}
                  {iconDataUrl ? (
                    <img
                      src={iconDataUrl}
                      alt=""
                      aria-hidden
                      className="mr-1.5 size-3.5 flex-shrink-0 rounded-sm object-contain"
                    />
                  ) : dotColor ? (
                    <span
                      aria-hidden
                      className="mr-1.5 size-1.5 rounded-full flex-shrink-0 inline-block"
                      style={{ background: dotColor }}
                    />
                  ) : null}
                  {repo}
                  {/* CTL-980: twistie immediately AFTER the label text (no ml-auto).
                      A small ml-1 gap keeps it visually adjacent to the label. */}
                  <ChevronRightIcon
                    className={cn(
                      "ml-1 size-3 flex-shrink-0 transition-transform duration-200",
                      isOpen && "rotate-90",
                    )}
                  />
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <SidebarGroupContent>
                    <SidebarMenu>
                      {OPERATE_ITEMS.map((item) => renderOperateItem(item, repo, true))}
                    </SidebarMenu>
                  </SidebarGroupContent>
                </CollapsibleContent>
              </SidebarGroup>
            </Collapsible>
          );
        })}

        {/* ── OBSERVE — collapsible, defaults collapsed, "soon" items ──────── */}
        {/* CTL-977: natural-case "Observe", twistie on RIGHT to match project groups. */}
        {/* OBS-5: force-open when a live OBSERVE surface is active (e.g. reached via
            the `g t` chord or a fresh load) so the selected item is never hidden
            inside a collapsed group — mirrors the per-project groupContainsActive. */}
        <Collapsible
          open={observeOpen || observeContainsActive}
          onOpenChange={(open) => {
            if (!observeContainsActive) setObserveOpen(open);
          }}
          className="group/observe"
        >
          <SidebarGroup className="pt-0">
            <CollapsibleTrigger className={GROUP_TRIGGER_BASE}>
              Observe
              {/* CTL-980: twistie immediately after label (no ml-auto). */}
              <ChevronRightIcon className="ml-1 size-3 flex-shrink-0 transition-transform duration-200 group-data-[state=open]/observe:rotate-90" />
            </CollapsibleTrigger>
            <CollapsibleContent>
              <SidebarGroupContent>
                <SidebarMenu>
                  {/* OBS-5: live OBSERVE items — clickable, no "soon" badge. Styled
                      identically to OPERATE items (CTL-980/981: 16px icon via
                      size-4, weight-500 muted-inactive label / accent-active) so
                      the nav styling never regresses. OBSERVE surfaces are not
                      repo-scoped, so the active check is surface-only. */}
                  {OBSERVE_LIVE.map((item) => {
                    const active = surface === item.surface;
                    return (
                      <SidebarMenuItem key={item.surface}>
                        <SidebarMenuButton
                          isActive={active}
                          tooltip={item.label}
                          onClick={() => go(item.surface)}
                          className={cn(
                            active
                              ? "text-sidebar-primary"
                              : "font-medium text-sidebar-foreground/72 hover:text-sidebar-foreground",
                          )}
                        >
                          <span className="relative flex shrink-0 items-center justify-center">
                            <item.icon className="size-4 shrink-0" />
                          </span>
                          <span>{item.label}</span>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    );
                  })}
                  {OBSERVE_SOON.map((item) => (
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
