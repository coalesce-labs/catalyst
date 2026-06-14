import { C, laneTint } from "./board-tokens";

/** Resolve a swimlane surface background: tint over C.s0 when the lane's repo
 *  has a resolved hue, else plain C.s0. (repoKey → hue `.bg` hex.)
 *  CTL-1146: tray bases on s0 (a step below canvas) so cards (s2) read as clearly elevated. */
export function laneSurfaceBg(
  repo: string | null | undefined,
  laneColors: Record<string, string>,
  base: string = C.s0,
): string {
  return laneTint(repo ? laneColors[repo] : undefined, base);
}
