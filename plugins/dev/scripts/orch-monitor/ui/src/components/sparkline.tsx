// sparkline.tsx — a tiny dependency-free SVG sparkline for the CTL-917 (DETAIL6)
// burn / telemetry strips. Renders a polyline over a [epochSeconds, value]
// series; an empty series renders nothing (the caller shows the scalar fallback
// instead). No axes, no labels — a glanceable inline trend, the design's "▁▂▃▅▆█"
// shape rendered as real geometry.
import type { SparklinePoint } from "@/board/worker-burn-data";

// OBS-1: default stroke/fill uses the categorical chart palette token
// (--chart-1, brand blue) rather than the reserved LIVE signal — sparklines
// show trend, not liveness. Callers can still override `color`.
export function Sparkline({
  points,
  width = 64,
  height = 18,
  color = "var(--chart-1)",
  ariaLabel,
}: {
  points: SparklinePoint[];
  width?: number;
  height?: number;
  color?: string;
  ariaLabel?: string;
}) {
  if (points.length === 0) return null;

  const ys = points.map((p) => p[1]);
  const xs = points.map((p) => p[0]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys, 0);
  const maxY = Math.max(...ys);
  const spanX = maxX - minX || 1;
  const spanY = maxY - minY || 1;

  // A single point has no line — draw it as a centred dot so the tile isn't blank.
  if (points.length === 1) {
    const cx = width / 2;
    const cy = height / 2;
    return (
      <svg
        data-sparkline="point"
        width={width}
        height={height}
        role="img"
        aria-label={ariaLabel}
        style={{ display: "block" }}
      >
        <circle cx={cx} cy={cy} r={1.6} fill={color} />
      </svg>
    );
  }

  const coords = points
    .map(([t, v]) => {
      const x = ((t - minX) / spanX) * (width - 2) + 1;
      // SVG y grows downward — invert so a rising value rises visually.
      const y = height - 1 - ((v - minY) / spanY) * (height - 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  return (
    <svg
      data-sparkline="line"
      width={width}
      height={height}
      role="img"
      aria-label={ariaLabel}
      style={{ display: "block" }}
    >
      <polyline
        points={coords}
        fill="none"
        stroke={color}
        strokeWidth={1.25}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}
