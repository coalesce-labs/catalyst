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

// ── display-name helpers (CTL-1012) ───────────────────────────────────────────
// ONE source of human-readable entity naming. The sidebar nav groups, the board
// lane headers (Swimlane + BoardList), and the detail-page Project/Repo/Team rows
// all derive their spelled-out names here so the casing rule cannot drift.
//
// A repo short-name ("adva", "catalyst", "rightsite-cloud") is the only ground
// truth we have client-side; we display-case it (split on -/_/space, capitalize
// each token: "adva" → "Adva", "my-app" → "My App"). Team lanes append the bare
// Linear key in parens — "Adva (ADV)" — so the operator keeps the orientable key
// while reading the brand. The team→repo bridge is the lane's representative
// entity (each board entity carries BOTH team + repo), surfaced as `Lane.repo`.

/**
 * Display-case a repo short-name into a readable brand name.
 * Splits on `-`, `_`, and whitespace, capitalizes each token's first letter,
 * and rejoins with a space. Fail-soft: empty/blank input returns "".
 *   "adva" → "Adva" · "catalyst" → "Catalyst" · "rightsite-cloud" → "Rightsite Cloud"
 */
export function displayCaseName(raw: string | null | undefined): string {
  if (!raw) return "";
  return raw
    .split(/[-_\s]+/)
    .filter((t) => t.length > 0)
    .map((t) => t.charAt(0).toUpperCase() + t.slice(1))
    .join(" ");
}

/** The grouping axes that carry a spelled-out lane name (mirrors the Swimlane union
 *  minus the host/none axes, which keep their existing label verbatim). */
export type DisplayAxis = "team" | "repo" | "project" | "host" | "none";

/**
 * The spelled-out lane-header name for a grouping axis (CTL-1012).
 *   - team:    "Adva (ADV)" — display-cased repo brand + the bare Linear key in parens.
 *              Falls back to the bare key when no repo is known ("ADV").
 *   - repo:    "Catalyst" — display-cased repo short-name. Falls back to the raw key.
 *   - project: the project name verbatim (already human-readable from Linear).
 *   - host/none: the existing label verbatim (host = node name; none = "").
 *
 * `key` is the lane key (team key / repo short-name / project name / host id).
 * `label` is buildLanes' resolved label (used verbatim for project/host/none and
 * for the catch-all "Unassigned"/"No team" lanes). `repo` is the lane's
 * representative repo short-name (the team→repo bridge); null when absent.
 */
export function laneDisplayName(
  axis: DisplayAxis,
  key: string,
  label: string,
  repo: string | null | undefined,
): string {
  // The catch-all lane (Unassigned / No team) keeps its fallback label verbatim.
  if (label === "Unassigned" || label === "No team") return label;
  if (axis === "team") {
    const brand = displayCaseName(repo);
    return brand ? `${brand} (${key})` : label;
  }
  if (axis === "repo") {
    return displayCaseName(key) || label;
  }
  // project / host / none → the existing label is already the right human name.
  return label;
}

// ── breadcrumbFor ─────────────────────────────────────────────────────────────

// OBS-5: the OPERATE breadcrumb labels. OBSERVE surfaces resolve their crumb via
// SURFACE_BREADCRUMB in surface.ts, not this scope-aware path, so they fall back
// to the `?? surface` default below (and never appear under an "Overall"/repo
// scope). Partial<> keeps this total without enumerating the OBSERVE surfaces.
const SURFACE_LABEL: Partial<Record<Surface, string>> = {
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

// ── detailCrumbFor ────────────────────────────────────────────────────────────

/**
 * The final detail crumb for a pathname: the decoded ticket/worker id when the
 * pathname is a detail route (`/ticket/<id>` or `/worker/<id>`), else null.
 * CTL-1003 §A1: the single header appends this to the surface trail so a ticket
 * page reads "Overall › Tickets › CTL-729" with the key as the last crumb.
 *
 * Pure + total: never throws — a malformed/over-segmented path (e.g.
 * `/ticket/CTL-1/extra`) or a non-detail path (`/board`) returns null, and a
 * malformed percent-encoding falls back to the raw id rather than throwing.
 */
export function detailCrumbFor(pathname: string): string | null {
  const m = /^\/(?:ticket|worker)\/([^/]+)$/.exec(pathname);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
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
