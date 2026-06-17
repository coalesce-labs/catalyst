// project-mark-icon.tsx — renders a ProjectMark as a tinted Phosphor glyph or favicon
// img. Used on cards, lane headers, and the sidebar (CTL-1208, CTL-1233, CTL-1249).
// CTL-1249: featured glyphs render synchronously (SSR-safe); non-featured glyphs render a
// neutral placeholder while their per-glyph chunk loads (and on miss/error — fail-open), then
// re-render as the resolved component. Each non-featured glyph pulls only its own ~6-12 KB chunk.
import { resolvePhosphorIcon, loadGlyph, useGlyphLoad } from "@/lib/phosphor-icons";
import type { ProjectMark } from "@/lib/project-mark";

interface ProjectMarkIconProps {
  mark: ProjectMark;
  /** CSS color string for glyph tinting (typically NAMED_COLORS[hue].text). */
  color: string;
  size?: number;
}

/** Neutral square placeholder shown while a non-featured glyph's chunk loads (or on miss/error). */
function GlyphPlaceholder({ size }: { size: number }) {
  return (
    <span
      data-glyph-placeholder
      aria-hidden
      style={{
        width: size,
        height: size,
        display: "block",
        flex: "0 0 auto",
        borderRadius: 3,
        background: "var(--s2, rgba(127,127,127,0.12))",
      }}
    />
  );
}

/**
 * Render the resolved ProjectMark for a repo:
 *  - glyph → Phosphor fill-weight SVG tinted in `color` (featured: sync; non-featured: lazy)
 *  - favicon → <img> with the existing border-radius / object-contain style
 *  - none → null (caller falls back to its dot / ActivityDot)
 *
 * Non-featured glyphs render a neutral placeholder until their per-glyph chunk resolves; a
 * miss/error keeps the placeholder (fail-open) rather than hanging.
 */
export function ProjectMarkIcon({ mark, color, size = 14 }: ProjectMarkIconProps) {
  const glyphName = mark.kind === "glyph" ? mark.name : "";
  const state = useGlyphLoad(glyphName); // unconditional hook (rules-of-hooks safe)
  if (mark.kind === "glyph") {
    const G = resolvePhosphorIcon(mark.name);
    if (state === "ready" && G) {
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
    if (state === "idle") void loadGlyph(mark.name); // trigger once; loading/missing/error → placeholder
    return <GlyphPlaceholder size={size} />;
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
