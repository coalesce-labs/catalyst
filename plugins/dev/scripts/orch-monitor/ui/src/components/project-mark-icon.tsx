// project-mark-icon.tsx — renders a ProjectMark as a tinted Phosphor glyph or favicon
// img. Used on cards, lane headers, and the sidebar (CTL-1208).
import { GLYPH_COMPONENTS } from "@/lib/project-glyph-set";
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
 */
export function ProjectMarkIcon({ mark, color, size = 14 }: ProjectMarkIconProps) {
  if (mark.kind === "glyph") {
    const G = GLYPH_COMPONENTS[mark.name];
    if (!G) return null;
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
