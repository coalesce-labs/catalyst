import { useEffect } from "react";
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

import { useNavigate } from "@tanstack/react-router";

import { cn } from "@/lib/utils";
import { useSurface, type Surface } from "@/lib/surface";
// CTL-989 — nav WRITES go through router.navigate (URL = source of truth for
// location). The active surface + Settings-open are READ from the route via
// useSurface(); scope is written onto the `?scope` typed search param.
import { surfaceToPath, SETTINGS_PATH } from "@/lib/route-surface";
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
import {
  buildNavGroups,
  displayCaseName,
  projectWorkerCount,
  projectQueueDepth,
  overallWorkerCount,
  overallQueueDepth,
} from "@/lib/nav-model";
import {
  repoScopeAtom,
  navGroupsOpenAtom,
  navOverallOpenAtom,
  navObserveOpenAtom,
} from "@/board/nav-store";
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
// CTL-1034 — sidebar sections refinement (NOT a redesign — Linear-calm restraint):
//   1. EVERY section collapses: Overall + each project + Observe each have a clickable
//      header row that folds the section; the open/closed bit persists across reloads
//      (navOverallOpenAtom / navGroupsOpenAtom / navObserveOpenAtom in nav-store).
//   2. Project headers read as real headings: Title-Cased via displayCaseName ("adva"→
//      "Adva", "catalyst"→"Catalyst") at heading weight/size on par with the "Overall"/
//      "Projects" SidebarGroupLabels — not the tiny lowercase rows they were.
//   3. Child hierarchy: project children indent under the header with a subtle guide
//      line (border-l), mirroring how Linear nests team children.
//   4. Signal survives collapse: a collapsed section whose children carry a live count /
//      attention state shows a subtle dot on its header so signal is not lost.
//   The twistie is RIGHT-ALIGNED (ml-auto) per the CTL-977 convention.

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

/**
 * CTL-1034 §4 — a subtle attention dot rolled up onto a COLLAPSED section header
 * so a live count / anomaly carried by a hidden child isn't lost. Kept calm: a
 * small 6px dot pinned at the right edge (before the chevron), emerald for a live
 * count, amber for an anomaly. Only rendered when the section is collapsed AND a
 * child has signal (the caller gates this), so an expanded section stays clean.
 */
function SectionSignalDot({ kind }: { kind: "live" | "anomaly" }) {
  return (
    <span
      aria-hidden
      className={cn(
        "ml-auto size-1.5 shrink-0 rounded-full",
        kind === "live" ? "bg-green" : "bg-yellow",
      )}
    />
  );
}

// ── OBSERVE — live items (clickable surfaces) ────────────────────────────────
// OBS-5: Telemetry is the first OBSERVE surface to ship a real content shell.
// OBS-10: FinOps is the second — the dollar+ROI hero + spend-over-time bars.
// OBS-16: Utilization is the third — the slot-occupancy hero + STARVED/JAMMED
// pathology badge + idle list + 429 + active-time.
// OBS-18: Fleet Ops is the fourth — host-health hero + host matrix + stuck/dead
// reap hints (board + /api/cluster + events only). All clickable nav items; the
// remaining one (DevOps) stays disabled "soon" until its own OBS ticket lands.
const OBSERVE_LIVE: Array<{ surface: Surface; label: string; icon: typeof InboxIcon }> = [
  { surface: "telemetry", label: "Telemetry", icon: ActivityIcon },
  { surface: "utilization", label: "Utilization", icon: GaugeIcon },
  { surface: "finops", label: "FinOps", icon: WalletIcon },
  { surface: "fleetops", label: "Fleet Ops", icon: ServerIcon },
];

// ── OBSERVE — disabled "soon" items ──────────────────────────────────────────
const OBSERVE_SOON = [
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
// CTL-1034: twistie is RIGHT-ALIGNED again (per the CTL-977 convention) so every
// section header reads with the chevron pinned to the right edge; this also leaves
// room for the collapsed-section signal dot just before it (§4). The Overall and
// Observe section headers use this same trigger so all sections share one chrome.
const GROUP_TRIGGER_BASE = cn(
  "flex h-7 w-full shrink-0 items-center rounded-md px-2 outline-hidden",
  // CTL-977: no uppercase — render names in their natural case; muted/quiet color.
  "text-[11px] font-medium text-sidebar-foreground/45",
  "transition-[margin,opacity,color] duration-200 ease-linear",
  "cursor-pointer hover:text-sidebar-foreground/70 focus-visible:ring-2 focus-visible:ring-sidebar-ring",
  "group-data-[collapsible=icon]:-mt-8 group-data-[collapsible=icon]:opacity-0",
);

// CTL-1034 §2: the PROJECT header trigger reads as a real section heading — at the
// weight/size/contrast of the "Overall"/"Projects" SidebarGroupLabels
// (text-xs / font-medium / text-sidebar-foreground/70), bumped a touch brighter
// (/80) because it carries the project icon and anchors its child group. NOT the
// minuscule /45 11px row it was. Linear-calm: weight & case over loudness — no
// uppercase, no shouting color.
const PROJECT_HEADER_TRIGGER = cn(
  "flex h-8 w-full shrink-0 items-center gap-1.5 rounded-md px-2 outline-hidden",
  "text-xs font-medium text-sidebar-foreground/80",
  "transition-[margin,opacity,color] duration-200 ease-linear",
  "cursor-pointer hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring",
  "group-data-[collapsible=icon]:-mt-8 group-data-[collapsible=icon]:opacity-0",
);

// CTL-1034 §3: project children indent under their header with a subtle guide line
// (a left border), mirroring how Linear nests team children. Applied to the
// SidebarMenu inside each project's CollapsibleContent. Reuses the sidebar-border
// token + the SidebarMenuSub geometry (ml-3.5 / border-l / pl) so the guide reads
// identically to the rest of the shell.
const PROJECT_CHILD_GUIDE = cn(
  "ml-3.5 border-l border-sidebar-border pl-2.5",
);

export function AppSidebar() {
  // CTL-989 — surface + settingsOpen are READ from the route (useSurface derives
  // them from location.pathname). Nav WRITES go through router.navigate below.
  const { surface, settingsOpen } = useSurface();
  const navigate = useNavigate();
  const { setOpenMobile, isMobile } = useSidebar();
  const { theme, toggle: toggleTheme } = useTheme();
  // CTL-1034: the Overall + Observe sections are now collapsible with persisted
  // open-state (atomWithStorage), matching the per-project groups. Both default
  // open; a section force-renders open when it contains the active surface.
  const [overallOpen, setOverallOpen] = useAtom(navOverallOpenAtom);
  const [observeOpen, setObserveOpen] = useAtom(navObserveOpenAtom);
  // CTL-945: consume from AppShell's shared contexts — no new EventSources opened.
  // CTL-896 / SHELL6 — the live nav signal off the read-model SSE projection.
  const nav = useNavSignalContext();
  // CTL-898 / SHELL8 — the live PER-NODE cluster-health signal.
  const cluster = useClusterSignalContext();
  const { scope, setScope } = useNodeScope();
  const showNodeFilter = shouldShowNodeFilter(cluster);

  // CTL-944 — the active repo scope and per-group open state.
  // CTL-989: repoScope is READ from the atom (a mirror of the `?scope` URL search
  // param, synced by AppShell). The active-item check compares against it; scope
  // CHANGES are written onto the URL via navigate({search:{scope}}) in `go`.
  const [repoScope] = useAtom(repoScopeAtom);
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

  // CTL-989: navigate to the surface's route (client-side; URL = source of truth)
  // and, when a scope is supplied, write it onto the `?scope` typed search param
  // (the "all" sentinel clears the param so the canonical URL has no ?scope). When
  // no scope is supplied the current scope is preserved.
  function go(s: Surface, scopeVal?: string) {
    void navigate({
      to: surfaceToPath(s),
      search: (prev) =>
        scopeVal !== undefined
          ? { ...prev, scope: scopeVal === "all" ? undefined : scopeVal }
          : prev,
    });
    if (isMobile) setOpenMobile(false);
  }

  // OBS-5: force the OBSERVE group open while a live OBSERVE surface is active.
  const observeContainsActive = OBSERVE_LIVE.some(
    (item) => item.surface === surface,
  );

  // CTL-1037 §A/§B — nav-row counts are derived from the RESIDENT board snapshot
  // (the same source the live-status strip + control tower read), NOT the server's
  // nav-signal workerCount (which is workers.length — total, including dead/stale).
  // This makes every count honest and per-project-scopable from one client-side
  // rule: Workers = genuinely-active workers (activeState === "active"); Queue =
  // tickets waiting for a slot. Overall ("all") sums the fleet; a repo scope filters
  // by .repo. Falls back to the nav signal only when the snapshot hasn't loaded yet.
  //
  // Returns the numeric count for Workers/Queue, or null for rows that carry no
  // count. The CALLER decides visibility (Workers hides 0; Queue keeps an
  // intentional 0 — see renderOperateItem).
  function rowCount(s: Surface, scopeVal: string): number | null {
    if (s === "workers") {
      if (payload) {
        return scopeVal === "all"
          ? overallWorkerCount(payload)
          : projectWorkerCount(payload, scopeVal);
      }
      // Snapshot not loaded yet — fall back to the global signal for the "all" row.
      return scopeVal === "all" && nav ? nav.workerCount : null;
    }
    if (s === "queue") {
      if (payload) {
        return scopeVal === "all"
          ? overallQueueDepth(payload)
          : projectQueueDepth(payload, scopeVal);
      }
      return scopeVal === "all" && nav ? nav.queueDepth : null;
    }
    return null;
  }
  // CTL-1037 §A — the green PRESENCE dot extends to every Workers row (overall AND
  // per-project): it lights when that scope has at least one genuinely-active
  // worker, hidden otherwise. The Board row keeps its amber anomaly dot.
  function liveDot(s: Surface, scopeVal: string): "live" | "anomaly" | null {
    if (s === "workers") {
      const c = rowCount("workers", scopeVal);
      return c != null && c > 0 ? "live" : null;
    }
    if (s === "board") {
      if (!nav) return null;
      return nav.anomaly ? "anomaly" : null;
    }
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
    // CTL-1037 §A: the presence dot now lights for the Workers row at EVERY scope
    // (overall + per-project), keyed off that scope's active-worker count.
    const dot = liveDot(item.surface, scopeVal);
    const active = isItemActive(item.surface, scopeVal);

    // CTL-1037 §B — resolve the row's count + an unambiguous hover tooltip per row.
    //   Workers → "N active workers" (active = genuinely running, not dead/stale),
    //             count hidden when 0 (no signal, and the dot already conveys none).
    //   Queue   → "N waiting for a slot"; the 0 is KEPT VISIBLE intentionally
    //             (decision: a Queue row with no number reads as "unknown/loading"
    //             rather than "empty" — the explicit 0 says "nothing is waiting",
    //             which is genuine signal for a capacity row). Other rows: no count.
    const workerN = item.surface === "workers" ? rowCount("workers", scopeVal) : null;
    const queueN = item.surface === "queue" ? rowCount("queue", scopeVal) : null;

    // The neutral count badge (Workers/Queue) and its clarifying tooltip text.
    let countBadge: number | null = null;
    let rowTooltip = item.label;
    if (item.surface === "workers" && workerN != null) {
      if (workerN > 0) countBadge = workerN; // hide the zero — the dot says "none"
      rowTooltip = `${workerN} active worker${workerN === 1 ? "" : "s"}`;
    } else if (item.surface === "queue" && queueN != null) {
      countBadge = queueN; // keep the 0 — "nothing waiting" is real signal
      rowTooltip = `${queueN} waiting for a slot`;
    }

    return (
      <SidebarMenuItem key={`${scopeVal}:${item.surface}`}>
        <SidebarMenuButton
          isActive={active}
          tooltip={rowTooltip}
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
            {/* CTL-1037 §A: presence dot at every scope, not just "all". */}
            {dot && <StatusDot kind={dot} />}
          </span>
          <span>{item.label}</span>
        </SidebarMenuButton>
        {countBadge != null && <SidebarMenuBadge>{countBadge}</SidebarMenuBadge>}
      </SidebarMenuItem>
    );
  }

  // Whether a per-project group contains the active item (force-open).
  function groupContainsActive(groupScope: string): boolean {
    return repoScope === groupScope || OPERATE_ITEMS.some(
      (item) => isItemActive(item.surface, groupScope),
    );
  }

  // CTL-1034 §4 — roll a collapsed section's child signal up onto its header so a
  // live count / anomaly carried by a hidden child isn't lost. "live" (emerald) when
  // a child has running workers or queued work; "anomaly" (amber) when the board
  // carries an anomaly. Returns null when there is no signal. The caller only renders
  // the dot while the section is COLLAPSED — an open section shows its children, so a
  // header dot would be redundant.
  //   - "all"      → the global nav signal (workerCount / queueDepth / anomaly).
  //   - repo scope → that repo's resident-payload worker/queue counts (the per-project
  //                  BFF projection isn't wired yet, so derive from the board snapshot).
  //   - "observe"  → OBSERVE surfaces carry no per-section count today → always null.
  // CTL-1037 §B: the "all" branch now derives its honest active worker count from
  // the resident snapshot (overallWorkerCount), falling back to the nav signal only
  // before the snapshot loads, so the rolled-up dot agrees with the row badges.
  function sectionSignal(scopeVal: string): "live" | "anomaly" | null {
    if (scopeVal === "observe") return null;
    if (scopeVal === "all") {
      if (!nav && !payload) return null;
      if (nav?.anomaly) return "anomaly";
      const workers = payload ? overallWorkerCount(payload) : (nav?.workerCount ?? 0);
      const queue = payload ? overallQueueDepth(payload) : (nav?.queueDepth ?? 0);
      if (workers > 0 || queue > 0) return "live";
      return null;
    }
    if (!payload) return null;
    if (
      projectWorkerCount(payload, scopeVal) > 0 ||
      projectQueueDepth(payload, scopeVal) > 0
    ) {
      return "live";
    }
    return null;
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
        {/* ── OVERALL: collapsible all-projects group (scope = "all") ───────── */}
        {/* CTL-960: "Operate" renamed to "Overall" — single term for the all-projects
            scope consistent with the breadcrumb label from breadcrumbFor("*", "all"). */}
        {/* CTL-1034 §1: Overall is now COLLAPSIBLE like every other section. Its header
            uses SidebarGroupLabel (asChild → the CollapsibleTrigger) so the heading
            chrome is identical to "Projects", the open-state persists (navOverallOpenAtom),
            and the section force-opens when an "all"-scoped surface is active. */}
        {(() => {
          const overallForceOpen = groupContainsActive("all");
          const overallIsOpen = overallForceOpen || overallOpen;
          const overallSignal = sectionSignal("all");
          return (
            <Collapsible
              open={overallIsOpen}
              onOpenChange={(open) => {
                if (!overallForceOpen) setOverallOpen(open);
              }}
              className="group/overall"
            >
              <SidebarGroup className="pb-0">
                <SidebarGroupLabel asChild>
                  <CollapsibleTrigger className="cursor-pointer">
                    Overall
                    {/* CTL-1034 §4: collapsed-section signal dot rolls child signal up. */}
                    {!overallIsOpen && overallSignal && (
                      <SectionSignalDot kind={overallSignal} />
                    )}
                    {/* CTL-1034: twistie right-aligned (CTL-977 convention). */}
                    <ChevronRightIcon
                      className={cn(
                        "size-3 flex-shrink-0 transition-transform duration-200",
                        overallIsOpen ? "rotate-90" : "",
                        overallIsOpen || !overallSignal ? "ml-auto" : "ml-1",
                      )}
                    />
                  </CollapsibleTrigger>
                </SidebarGroupLabel>
                <CollapsibleContent>
                  <SidebarGroupContent>
                    <SidebarMenu>
                      {OPERATE_ITEMS.map((item) => renderOperateItem(item, "all"))}
                    </SidebarMenu>
                  </SidebarGroupContent>
                </CollapsibleContent>
              </SidebarGroup>
            </Collapsible>
          );
        })()}

        {/* ── PER-PROJECT GROUPS: one collapsible per repo ────────────────── */}
        {/* CTL-980: "Projects" / "Your projects" section heading above the collapsible
            project rows — mirrors Linear's "Your teams" parent section label. Only
            render the heading when there is at least one project to show. */}
        {repos.length > 0 && (
          <SidebarGroup className="pt-0 pb-0">
            <SidebarGroupLabel>Projects</SidebarGroupLabel>
          </SidebarGroup>
        )}
        {/* CTL-1034 §2: Title-Cased repo name (displayCaseName) at heading weight/size
            (PROJECT_HEADER_TRIGGER), favicon stays LEFT of the label. §1: twistie is
            RIGHT-aligned (ml-auto) per CTL-977. §3: children indented under a guide line.
            §4: a collapsed project with live children shows a signal dot on its header. */}
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
          // CTL-1034 §2: spell the repo short-name out as a heading ("adva" → "Adva").
          const repoLabel = displayCaseName(repo) || repo;
          // CTL-1034 §4: a collapsed project rolls its child signal up onto the header.
          const repoSignal = sectionSignal(repo);
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
                <CollapsibleTrigger className={PROJECT_HEADER_TRIGGER}>
                  {/* CTL-961: favicon takes priority over the color dot; only show dot
                      when no favicon is available. Never show a placeholder. */}
                  {iconDataUrl ? (
                    <img
                      src={iconDataUrl}
                      alt=""
                      aria-hidden
                      className="size-4 flex-shrink-0 rounded-sm object-contain"
                    />
                  ) : dotColor ? (
                    <span
                      aria-hidden
                      className="size-2 rounded-full flex-shrink-0 inline-block"
                      style={{ background: dotColor }}
                    />
                  ) : null}
                  <span className="truncate">{repoLabel}</span>
                  {/* CTL-1034 §4: collapsed-section signal dot. */}
                  {!isOpen && repoSignal && <SectionSignalDot kind={repoSignal} />}
                  {/* CTL-1034: twistie RIGHT-aligned (ml-auto) per CTL-977 convention;
                      falls back to ml-1 when a signal dot already claimed ml-auto. */}
                  <ChevronRightIcon
                    className={cn(
                      "size-3 flex-shrink-0 transition-transform duration-200",
                      isOpen && "rotate-90",
                      isOpen || !repoSignal ? "ml-auto" : "ml-1",
                    )}
                  />
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <SidebarGroupContent>
                    {/* CTL-1034 §3: indent + guide line so children read as subordinate
                        to the project header (mirrors Linear's nested team children). */}
                    <SidebarMenu className={PROJECT_CHILD_GUIDE}>
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
              {/* CTL-1034: twistie RIGHT-aligned (ml-auto) per the CTL-977 convention. */}
              <ChevronRightIcon className="ml-auto size-3 flex-shrink-0 transition-transform duration-200 group-data-[state=open]/observe:rotate-90" />
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
                // CTL-989: Settings is the /settings route, not an inset takeover.
                void navigate({ to: SETTINGS_PATH, search: (prev) => prev });
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
