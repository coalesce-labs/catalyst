// nav-model.ts — the project-grouped nav model (CTL-930 / CTL-944).
// Framework-free (same discipline as lib/surface.ts, lib/repo-scope.ts).
// Defines the nav IA: Overall (all) + one group per repo + Observe (last).
//
// CTL-930 deviation note (recorded here per design doc): the CTL-930 Gherkin
// said "no separate Workers item in the left nav" (Workers rides a lens toggle in
// the display popover). The operator's 2026-06-09 brief overrides this: Workers
// stays a FIRST-CLASS nav destination in every group so the user makes the
// Tickets vs Workers choice upfront at the nav level. Queue is not folded.

import {
  InboxIcon,
  LayoutGridIcon,
  UsersIcon,
  ListOrderedIcon,
  ActivityIcon,
  GaugeIcon,
  WalletIcon,
  ServerIcon,
  CodeIcon,
  type LucideIcon,
} from "lucide-react";
import type { Surface } from "./surface";
import type { BoardPayload } from "../board/types";

// ── Nav IA types ──────────────────────────────────────────────────────────────

/** A scoped surface address: which surface + which repo scope. */
export interface NavTarget {
  surface: Surface;
  scope: string; // REPO_SCOPE_ALL "all" | repo key | "observe"
}

/** A single nav item. */
export interface NavItem {
  target: NavTarget;
  label: string;
  /** Lucide icon component. */
  icon: LucideIcon;
  /** For Observe items: they're disabled "soon" placeholders. */
  disabled?: boolean;
}

/** A nav group (Overall / per-repo / Observe). */
export interface NavGroup {
  scope: string; // "all" | repo key | "observe"
  label: string;
  /** Dot color for per-repo groups (from repoColors config). */
  dotColor?: string;
  /**
   * CTL-961: auto-detected favicon as a data URL (fetched from the repo's
   * GitHub by the server, cached for 7 days). null = not yet fetched or not found.
   * Shown in preference to the color dot when present.
   */
  iconDataUrl?: string | null;
  items: NavItem[];
}

// ── Item factory ──────────────────────────────────────────────────────────────

const OPERATE_DEFS: Array<{ surface: Surface; label: string; icon: LucideIcon }> = [
  { surface: "home", label: "Inbox", icon: InboxIcon },
  { surface: "board", label: "Tickets", icon: LayoutGridIcon },
  { surface: "workers", label: "Workers", icon: UsersIcon },
  { surface: "queue", label: "Queue", icon: ListOrderedIcon },
];

const OBSERVE_DEFS: Array<{ label: string; icon: LucideIcon }> = [
  { label: "Telemetry", icon: ActivityIcon },
  { label: "Utilization", icon: GaugeIcon },
  { label: "FinOps", icon: WalletIcon },
  { label: "Fleet Ops", icon: ServerIcon },
  { label: "DevOps", icon: CodeIcon },
];

function makeOperateItems(scope: string): NavItem[] {
  return OPERATE_DEFS.map((def) => ({
    target: { surface: def.surface, scope },
    label: def.label,
    icon: def.icon,
  }));
}

// ── buildNavGroups ────────────────────────────────────────────────────────────

/**
 * Build the full nav group list: Overall (all) first, one group per repo in
 * `repos` order, then Observe (last). `repoColors` maps repo key → `{ text }`.
 * `repoIcons` optionally maps repo key → data URL for auto-detected favicons (CTL-961).
 *
 * Gherkin (CTL-944): project-grouped left nav — Overall flat, per-project
 * Collapsibles, Observe recessed and last.
 */
export function buildNavGroups(
  repos: readonly string[],
  repoColors: Readonly<Record<string, { text: string }>>,
  repoIcons?: Readonly<Record<string, string | null>>,
): NavGroup[] {
  const overall: NavGroup = {
    scope: "all",
    label: "Overall",
    items: makeOperateItems("all"),
  };

  const repoGroups: NavGroup[] = repos.map((repo) => ({
    scope: repo,
    label: repo,
    dotColor: repoColors[repo]?.text,
    iconDataUrl: repoIcons ? (repoIcons[repo] ?? null) : undefined,
    items: makeOperateItems(repo),
  }));

  const observe: NavGroup = {
    scope: "observe",
    label: "Observe",
    items: OBSERVE_DEFS.map((def) => ({
      // Observe items don't navigate to a real surface; use "home" as placeholder
      // but mark disabled so the caller can render them as "soon" items.
      target: { surface: "home" as Surface, scope: "observe" },
      label: def.label,
      icon: def.icon,
      disabled: true,
    })),
  };

  return [overall, ...repoGroups, observe];
}

// ── breadcrumbFor ─────────────────────────────────────────────────────────────

const SURFACE_LABEL: Record<Surface, string> = {
  home: "Inbox",
  board: "Tickets",
  workers: "Workers",
  queue: "Queue",
};

/**
 * Breadcrumb trail for a surface+scope combination.
 * e.g. breadcrumbFor("board", "all") → ["Overall", "Tickets"]
 *      breadcrumbFor("board", "catalyst") → ["catalyst", "Tickets"]
 */
export function breadcrumbFor(surface: Surface, scope: string): string[] {
  const scopeLabel = scope === "all" ? "Overall" : scope;
  const surfaceLabel = SURFACE_LABEL[surface] ?? surface;
  return [scopeLabel, surfaceLabel];
}

// ── paletteEntries ────────────────────────────────────────────────────────────

/** One group of entries for the ⌘K CommandDialog — the group heading + its items. */
export interface PaletteEntry {
  group: string;
  items: NavItem[];
}

/**
 * All nav groups in ⌘K palette form, excluding the Observe disabled-soon group.
 * The ⌘K dialog iterates these to build grouped CommandItems.
 */
export function paletteEntries(groups: NavGroup[]): PaletteEntry[] {
  return groups
    .filter((g) => g.scope !== "observe")
    .map((g) => ({
      group: g.label,
      items: g.items,
    }));
}

// ── projectWorkerCount / projectQueueDepth ────────────────────────────────────

/**
 * Count workers in a given repo that are actively running (activeState === "active").
 */
export function projectWorkerCount(payload: BoardPayload, repo: string): number {
  return payload.workers.filter(
    (w) => w.repo === repo && w.activeState === "active",
  ).length;
}

/**
 * Count queue items for the given repo.
 */
export function projectQueueDepth(payload: BoardPayload, repo: string): number {
  return payload.queue.filter((q) => q.repo === repo).length;
}
