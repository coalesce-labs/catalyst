import { C, laneTint } from "./board-tokens";

/** Resolve a swimlane surface background: tint over C.subtle when the lane's repo
 *  has a resolved hue, else plain C.subtle. (repoKey → hue `.bg` hex.) */
export function laneSurfaceBg(
  repo: string | null | undefined,
  laneColors: Record<string, string>,
  base: string = C.subtle,
): string {
  return laneTint(repo ? laneColors[repo] : undefined, base);
}
