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

/** Group-header icon: ONLY the repo axis has an icon source (team/project/host do not). */
export function groupIconSrc(
  axis: Swimlane,
  key: string | null | undefined,
  icons: RepoIconMap,
): string | null {
  if (axis !== "repo") return null;
  return resolveEntityIcon(key, icons);
}
