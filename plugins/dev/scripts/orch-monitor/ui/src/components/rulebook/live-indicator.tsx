// live-indicator.tsx — CTL-1103 Phase 4+5: per-rule firing count badge.
// Uses the --color-live token (distinct from strata + severity per Phase 5).
// Renders nothing when count is 0 (recording off or rule not firing).
import { liveIndicatorTone } from "@/lib/rulebook-theme";

interface LiveIndicatorProps {
  count: number;
  // CTL-1103 remediate: when provided, the badge becomes the dedicated
  // rule-selection affordance (opens the derivations rail). Previously the WHOLE
  // RuleCard was wrapped in a <button>, which nested the card's own Tabs buttons
  // and feed/cfg anchors inside a button (invalid HTML) and made tab-switching /
  // in-page nav double as rule selection. Scoping the click to this badge keeps
  // the affordance accessible without nesting interactive elements.
  onSelect?: () => void;
}

export function LiveIndicator({ count, onSelect }: LiveIndicatorProps) {
  if (count === 0) return null;
  const liveColor = liveIndicatorTone(true);
  const badgeClass =
    "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold";
  const badgeStyle = {
    background: `color-mix(in srgb, ${liveColor} 15%, transparent)`,
    color: liveColor,
  } as const;
  const dot = (
    <span
      className="inline-block h-1.5 w-1.5 rounded-full animate-pulse"
      style={{ background: liveColor }}
      aria-hidden
    />
  );

  if (onSelect) {
    return (
      <button
        type="button"
        className={`${badgeClass} cursor-pointer hover:brightness-110 transition`}
        style={badgeStyle}
        onClick={onSelect}
        aria-label={`Show derivations — ${count} firing`}
      >
        {dot}
        {count}
      </button>
    );
  }

  return (
    <span className={badgeClass} style={badgeStyle}>
      {dot}
      {count}
    </span>
  );
}
