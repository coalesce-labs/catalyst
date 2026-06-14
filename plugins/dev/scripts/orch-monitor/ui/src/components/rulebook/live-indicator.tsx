// live-indicator.tsx — CTL-1103 Phase 4+5: per-rule firing count badge.
// Uses the --color-live token (distinct from strata + severity per Phase 5).
// Renders nothing when count is 0 (recording off or rule not firing).
import { liveIndicatorTone } from "@/lib/rulebook-theme";

interface LiveIndicatorProps {
  count: number;
}

export function LiveIndicator({ count }: LiveIndicatorProps) {
  if (count === 0) return null;
  const liveColor = liveIndicatorTone(true);
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold"
      style={{
        background: `color-mix(in srgb, ${liveColor} 15%, transparent)`,
        color: liveColor,
      }}
    >
      <span
        className="inline-block h-1.5 w-1.5 rounded-full animate-pulse"
        style={{ background: liveColor }}
        aria-hidden
      />
      {count}
    </span>
  );
}
