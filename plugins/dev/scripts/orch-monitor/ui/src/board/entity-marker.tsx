// entity-marker.tsx — the board's entity status marker (CTL-998). Favicon + liveness
// badge when the repo has an icon; otherwise the unchanged ActivityDot. The ONLY new
// place LIVE cyan / red can appear, identical to ActivityDot's semantics.
import { ActivityDot } from "./Board";
import { C, LIVE } from "./board-tokens";
import type { BoardActiveState } from "./types";
import { resolveEntityIcon, liveBadgeKind } from "./entity-icon";
import { useRepoIconMap } from "./repo-icon-context";

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
  const src = resolveEntityIcon(repo, icons);
  if (!src) return <ActivityDot state={state} fallback={fallback} />;

  const badge = liveBadgeKind(state);
  return (
    <span style={{ position: "relative", display: "inline-flex", flex: "0 0 auto" }}>
      <img
        src={src}
        alt=""
        aria-hidden
        style={{ width: size, height: size, borderRadius: 4, objectFit: "contain", display: "block" }}
      />
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
