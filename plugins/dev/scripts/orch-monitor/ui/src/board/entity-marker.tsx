// entity-marker.tsx — the board's entity status marker (CTL-998, CTL-1208).
// Renders via ProjectMark (glyph | favicon | none) + liveness badge.
// Glyph: Phosphor fill-weight SVG tinted in the project accent color.
// Favicon: existing <img> with border-radius + object-contain.
// None: falls back to the unchanged ActivityDot.
import { ActivityDot } from "./Board";
import { C, LIVE } from "./board-tokens";
import type { BoardActiveState } from "./types";
import { resolveEntityMark, liveBadgeKind } from "./entity-icon";
import { useRepoIconMap } from "./repo-icon-context";
import { useResolvedRepoColors } from "@/hooks/use-resolved-repo-colors";
import { ProjectMarkIcon } from "@/components/project-mark-icon";

export function EntityMarker({
  repo,
  state,
  fallback,
  size = 14,
}: {
  repo: string | null | undefined;
  state: BoardActiveState;
  fallback: string;
  size?: number;
}) {
  const icons = useRepoIconMap();
  const resolvedColors = useResolvedRepoColors();
  const mark = resolveEntityMark(repo, icons);

  if (mark.kind === "none") return <ActivityDot state={state} fallback={fallback} />;

  // Glyph tint: the vivid `.text` accent for the repo's hue (same channel as card dots).
  // Favicon: color unused (img renders its own colors).
  const accentColor = (repo && resolvedColors[repo]?.text) || fallback;

  const badge = liveBadgeKind(state);
  return (
    <span style={{ position: "relative", display: "inline-flex", flex: "0 0 auto" }}>
      <ProjectMarkIcon mark={mark} color={accentColor} size={size} />
      {badge === "live" && (
        <span
          className="catalyst-live-dot"
          aria-hidden
          style={{ position: "absolute", top: -2, right: -2, width: 6, height: 6,
            borderRadius: "50%", background: LIVE, boxShadow: `0 0 0 2px ${C.s2}` }}
        />
      )}
      {badge === "stuck" && (
        <span
          aria-hidden
          style={{ position: "absolute", top: -2, right: -2, width: 6, height: 6,
            borderRadius: "50%", background: C.red, boxShadow: `0 0 0 2px ${C.s2}` }}
        />
      )}
    </span>
  );
}
