// status-icon.tsx — the Catalyst-specific StatusIcon glyph (CTL-900 / HOME2).
//
// A Linear-style status glyph that doubles as a progress meter: an SVG ring with
// a partial pie fill that steps empty → quarter → half → three-quarter → full →
// check, exactly the way Linear's workflow-state icons walk Backlog → Todo → In
// Progress → Done. The fill fraction is (phaseIndex + 1) / PHASE_COUNT and the
// whole glyph is COLORED by the current phase on the early→late spectrum
// (formatters.PHASE_COLORS). The operator reads BOTH "how far along" and "what
// stage" from ONE consistent slot — this intentionally REPLACES the old row of
// status/label chips (Direction A: status = a single dot/accent, not a cluster).
//
// This is a hand-rolled Catalyst-specific glyph (not a stock shadcn component),
// per the standing preference to hand-roll only Catalyst-specifics. Cyan
// (#5be0ff) stays RESERVED for the live signal and is never used here — the phase
// color comes from formatters.PHASE_COLORS, which excludes it.
import { cn } from "@/lib/utils";
import {
  isDoneStatus,
  phaseColor,
  phaseFraction,
  phaseIndexOf,
  PHASE_COUNT,
  PHASE_LABEL,
  type Phase,
} from "@/board/phase-model";

interface StatusIconProps {
  /** The ticket's current pipeline phase (canonical phase id). */
  phase: string;
  /** The ticket's current phase status — drives the terminal done disc+check. */
  status: string;
  /** Pixel size of the square glyph. */
  size?: number;
  className?: string;
}

export function StatusIcon({ phase, status, size = 16, className }: StatusIconProps) {
  const phaseIndex = phaseIndexOf(phase);
  const color = phaseColor(phase);
  const done = isDoneStatus(status);

  // Geometry: a ring of radius r, with an inner pie wedge whose angle encodes
  // progress. The CURRENT phase counts as in-flight, so the fraction is
  // (phaseIndex + 1) / PHASE_COUNT — phase 0 already shows a sliver of progress.
  const fraction = phaseFraction(phaseIndex);

  const c = size / 2;
  const ringR = size * 0.4; // outer ring radius
  const ringW = Math.max(1.5, size * 0.115); // ring stroke width
  const pieR = size * 0.225; // inner pie radius (the fill that grows)

  const stepLabel = phaseIndex >= 0 ? `step ${phaseIndex + 1} of ${PHASE_COUNT}` : "pre-pipeline";
  const phaseLabel = isKnownPhase(phase) ? PHASE_LABEL[phase] : phase;
  const label = done ? "Done" : `${phaseLabel} — ${stepLabel}`;

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={label}
      className={cn("shrink-0", className)}
    >
      <title>{label}</title>

      {/* The faint full-circle track — the "not yet" remainder. */}
      <circle
        cx={c}
        cy={c}
        r={ringR}
        fill="none"
        stroke={color}
        strokeOpacity={0.28}
        strokeWidth={ringW}
      />

      {done ? (
        // Terminal success: filled disc + check, the all-clear.
        <>
          <circle cx={c} cy={c} r={ringR + ringW / 2} fill={color} />
          <path
            d={checkPath(c, size)}
            fill="none"
            stroke="white"
            strokeWidth={Math.max(1.4, size * 0.11)}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      ) : (
        <>
          {/* Progress arc traced on the ring, full-opacity, from 12 o'clock. */}
          <RingArc cx={c} cy={c} r={ringR} fraction={fraction} color={color} width={ringW} />
          {/* Inner pie wedge that grows with progress — the Linear "fill". */}
          {fraction > 0 && <path d={piePath(c, pieR, fraction)} fill={color} />}
        </>
      )}
    </svg>
  );
}

/** Narrow a string to a known Phase for the label lookup (avoids an unsafe cast). */
function isKnownPhase(phase: string): phase is Phase {
  return phase in PHASE_LABEL;
}

/** A stroked arc along the ring from 12 o'clock, clockwise, for `fraction`. */
function RingArc({
  cx,
  cy,
  r,
  fraction,
  color,
  width,
}: {
  cx: number;
  cy: number;
  r: number;
  fraction: number;
  color: string;
  width: number;
}) {
  if (fraction <= 0) return null;
  // Near-full arcs render cleanly as a full circle to avoid a hairline seam.
  if (fraction >= 0.999) {
    return <circle cx={cx} cy={cy} r={r} fill="none" stroke={color} strokeWidth={width} />;
  }
  const start = polar(cx, cy, r, 0);
  const end = polar(cx, cy, r, fraction * 360);
  const largeArc = fraction > 0.5 ? 1 : 0;
  return (
    <path
      d={`M ${start.x} ${start.y} A ${r} ${r} 0 ${largeArc} 1 ${end.x} ${end.y}`}
      fill="none"
      stroke={color}
      strokeWidth={width}
      strokeLinecap="round"
    />
  );
}

/** SVG path for a pie wedge from 12 o'clock, clockwise, covering `fraction`. */
function piePath(c: number, r: number, fraction: number): string {
  if (fraction >= 0.999) {
    // Full disc.
    return `M ${c} ${c - r} A ${r} ${r} 0 1 1 ${c - 0.01} ${c - r} Z`;
  }
  const start = polar(c, c, r, 0);
  const end = polar(c, c, r, fraction * 360);
  const largeArc = fraction > 0.5 ? 1 : 0;
  return `M ${c} ${c} L ${start.x} ${start.y} A ${r} ${r} 0 ${largeArc} 1 ${end.x} ${end.y} Z`;
}

/** Point on a circle, angle measured clockwise from 12 o'clock (degrees). */
function polar(cx: number, cy: number, r: number, angleDeg: number) {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

/** A check mark sized to the glyph. */
function checkPath(c: number, size: number): string {
  const s = size;
  return `M ${c - s * 0.16} ${c + s * 0.01} L ${c - s * 0.04} ${c + s * 0.13} L ${c + s * 0.18} ${c - s * 0.13}`;
}
