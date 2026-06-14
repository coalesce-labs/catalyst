import { C, laneTint } from "./board-tokens";

/** Resolve a swimlane surface background: tint over C.s1 when the lane's repo
 *  has a resolved hue, else plain C.s1. (repoKey → hue `.bg` hex.)
 *  CTL-1144: tray bases on s1 so cards (s2) read as elevated. */
export function laneSurfaceBg(
  repo: string | null | undefined,
  laneColors: Record<string, string>,
  base: string = C.s1,
): string {
  return laneTint(repo ? laneColors[repo] : undefined, base);
}
