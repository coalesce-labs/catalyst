// project-mark-icon.tsx — renders a ProjectMark as a tinted Phosphor glyph or favicon
// img. Used on cards, lane headers, and the sidebar (CTL-1208, CTL-1233).
// CTL-1233: subscribes to the async Phosphor load so non-featured glyphs pop in
// once the chunk arrives; featured glyphs render synchronously (SSR-safe).
import { resolvePhosphorIcon, loadPhosphorRegistry, usePhosphorRegistry } from "@/lib/phosphor-icons";
import type { ProjectMark } from "@/lib/project-mark";

interface ProjectMarkIconProps {
  mark: ProjectMark;
  /** CSS color string for glyph tinting (typically NAMED_COLORS[hue].text). */
  color: string;
  size?: number;
}

/**
 * Render the resolved ProjectMark for a repo:
 *  - glyph → Phosphor fill-weight SVG tinted in `color`
 *  - favicon → <img> with the existing border-radius / object-contain style
 *  - none → null (caller falls back to its dot / ActivityDot)
 *
 * For non-featured glyphs: returns null until the full Phosphor chunk loads, then
 * re-renders with the component (fail-open — same as the pre-CTL-1233 "unknown glyph → null").
 */
export function ProjectMarkIcon({ mark, color, size = 14 }: ProjectMarkIconProps) {
  usePhosphorRegistry(); // re-render when the full set finishes loading
  if (mark.kind === "glyph") {
    const G = resolvePhosphorIcon(mark.name);
    if (!G) {
      // Non-featured & not yet loaded: trigger load, render nothing this paint.
      void loadPhosphorRegistry();
      return null;
    }
    return (
      <G
        weight="fill"
        color={color}
        size={size}
        aria-hidden
        style={{ flex: "0 0 auto", display: "block" }}
      />
    );
  }
  if (mark.kind === "favicon") {
    return (
      <img
        src={mark.dataUrl}
        alt=""
        aria-hidden
        style={{
          width: size,
          height: size,
          borderRadius: 4,
          objectFit: "contain",
          display: "block",
          flex: "0 0 auto",
        }}
      />
    );
  }
  return null;
}
