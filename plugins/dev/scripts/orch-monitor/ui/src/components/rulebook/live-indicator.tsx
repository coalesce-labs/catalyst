// live-indicator.tsx — CTL-1103 Phase 4: per-rule firing count badge.
// Renders nothing (muted) when count is 0 (recording off or rule not firing).
interface LiveIndicatorProps {
  count: number;
}

export function LiveIndicator({ count }: LiveIndicatorProps) {
  if (count === 0) return null;
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300">
      <span
        className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse"
        aria-hidden
      />
      {count}
    </span>
  );
}
