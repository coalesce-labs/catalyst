// entity-icon.ts — pure resolution of repo favicon + liveness-badge kind for the
// board's entity/group markers (CTL-998). No DOM, no React — unit-tested.
import type { RepoIconMap } from "@/hooks/use-repo-icons";
import type { BoardActiveState } from "./types";
import type { Swimlane } from "./prefs-store";

/** Best favicon dataUrl for an entity's repo, or null (fail-open: no repo / no icon). */
export function resolveEntityIcon(
  repo: string | null | undefined,
  icons: RepoIconMap,
): string | null {
  if (!repo) return null;
  return icons[repo]?.autoDataUrl ?? null;
}

/** Liveness badge to overlay on an icon. Preserves the invariant: cyan==live, red==stuck. */
export function liveBadgeKind(state: BoardActiveState): "live" | "stuck" | null {
  if (state === "active") return "live";
  if (state === "stuck") return "stuck";
  return null;
}

/** Group-header icon (legacy, CTL-998): ONLY the repo axis resolved an icon by its
 *  lane key. Superseded by `laneIconSrc` (CTL-1012), which brings the project mark
 *  to TEAM and PROJECT lanes too via the lane's representative repo. Kept for the
 *  axis-gating regression test. */
export function groupIconSrc(
  axis: Swimlane,
  key: string | null | undefined,
  icons: RepoIconMap,
): string | null {
  if (axis !== "repo") return null;
  return resolveEntityIcon(key, icons);
}

/** Lane-header icon (CTL-1012): the project mark for a team/repo/project lane,
 *  resolved from the lane's representative repo short-name (the team→repo bridge).
 *  The HOST axis returns null — its dot encodes live/degraded/offline and must NOT
 *  be replaced by an icon (Gherkin: "host lanes keep their liveness signal"). The
 *  `none` axis (flat board, no lane chrome) also returns null. Fail-open: a missing
 *  repo or undiscovered icon yields null so the caller renders its dot fallback. */
export function laneIconSrc(
  axis: Swimlane,
  repo: string | null | undefined,
  icons: RepoIconMap,
): string | null {
  if (axis === "host" || axis === "none") return null;
  return resolveEntityIcon(repo, icons);
}
