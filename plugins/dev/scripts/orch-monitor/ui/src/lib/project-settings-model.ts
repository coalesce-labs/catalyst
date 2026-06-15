// project-settings-model.ts — view-model for the per-project settings pane (CTL-1153 Phase 5).
// Pure module — no React, no network calls. All heavy lifting lives here; components stay thin.
import type { ProjectDescriptor } from "@/hooks/use-projects";

/** The canonical 12 Linear stateMap transition keys. */
export const STATE_MAP_KEYS = [
  "backlog", "todo", "triage", "research", "planning", "inProgress",
  "verifying", "reviewing", "remediating", "inReview", "done", "canceled",
] as const;

export type StateMapKey = (typeof STATE_MAP_KEYS)[number];

/** Human-readable label for each stateMap key (shown in the pane's input rows). */
export const STATE_MAP_KEY_LABEL: Record<StateMapKey, string> = {
  backlog: "Backlog",
  todo: "To Do",
  triage: "Triage",
  research: "Research",
  planning: "Planning",
  inProgress: "In Progress",
  verifying: "Verifying",
  reviewing: "Reviewing",
  remediating: "Remediating",
  inReview: "In Review",
  done: "Done",
  canceled: "Canceled",
};

/** One row in the project rail sidebar. */
export interface ProjectRailRow {
  /** Team key (UPPERCASE) — matches `descriptor.key`. */
  key: string;
  /** Effective display name (overlay.name ?? auto). */
  label: string;
  /** Resolved hue name for the dot, or null. */
  dotColorName: string | null;
  /** True when this repo has observed work. */
  hasWork: boolean;
  /** Icon data URL if available (for thumbnail), or null. */
  iconUrl: string | null;
}

/** Build the rail row list from the project roster. */
export function buildProjectRailRows(
  projects: readonly Pick<ProjectDescriptor, "key" | "name" | "defaultColor" | "hasWork">[],
): ProjectRailRow[] {
  return projects.map((p) => ({
    key: p.key,
    label: p.name,
    dotColorName: p.defaultColor ?? null,
    hasWork: p.hasWork,
    iconUrl: null,
  }));
}

/**
 * Find a project descriptor by team key. Returns null for an unknown/undefined key
 * so the settings surface can fall back to the global sections. Generic so the caller
 * gets back the full descriptor type it passed in, not a narrowed Pick.
 */
export function resolveSelectedProject<T extends Pick<ProjectDescriptor, "key">>(
  projects: readonly T[],
  key: string | undefined | null,
): T | null {
  if (!key) return null;
  return projects.find((p) => p.key === key) ?? null;
}

/**
 * Compute the changed keys between the current stateMap and an edited version.
 * Only includes keys whose value has changed AND is non-empty; omits unchanged or
 * cleared keys (empty string = inherit global, never written as a blank state name).
 */
export function diffStateMap(
  current: Record<string, string> | null | undefined,
  edited: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of STATE_MAP_KEYS) {
    const was = current?.[k] ?? "";
    const is = edited[k] ?? "";
    if (is !== "" && is !== was) out[k] = is;
  }
  return out;
}
