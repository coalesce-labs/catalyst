// kpi-number.tsx — the one hero number per surface (OBS-2). Big value + unit,
// with a delta pill whose color is driven by SEMANTICS, not by the sign of the
// delta: a falling cost is good (down-good → green), a falling throughput is bad
// (down-good would be wrong → use up-good). The caller declares intent via
// `deltaDirection` so each surface doesn't reinvent the convention (design §5 #5).
//
// motion (v12) drives a ~count-up on the numeric value so a hero number that
// updates live animates rather than snapping.

import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { useEffect } from "react";
import {
  animate,
  useMotionValue,
  useTransform,
  motion,
  useReducedMotion,
} from "motion/react";
import { ArrowDown, ArrowUp, Minus } from "lucide-react";

export type DeltaDirection = "up-good" | "down-good" | "neutral";

export interface KpiNumberProps {
  /** The numeric hero value (animated via count-up). */
  value: number;
  /** Unit suffix, e.g. "$", "/min", "%". Rendered small after the number. */
  unit?: string;
  /** Signed change vs the comparison window. Sign drives the arrow; magnitude is shown. */
  delta?: number;
  /** Label after the delta, e.g. "vs 7d avg". */
  deltaLabel?: string;
  /** Which direction is "good" — decides green vs red for a given delta sign. */
  deltaDirection?: DeltaDirection;
  /** Decimal places for the animated value (default 0). */
  precision?: number;
  /** Optional unit placement: prefix (e.g. "$") vs suffix (default). */
  unitPosition?: "prefix" | "suffix";
  className?: string;
}

// (delta sign × deltaDirection) → semantic good/bad/neutral.
function deltaTone(
  delta: number,
  direction: DeltaDirection,
): "good" | "bad" | "neutral" {
  if (direction === "neutral" || delta === 0) return "neutral";
  const rising = delta > 0;
  if (direction === "up-good") return rising ? "good" : "bad";
  // down-good
  return rising ? "bad" : "good";
}

const TONE_CLASSES: Record<"good" | "bad" | "neutral", string> = {
  good: "bg-green/15 text-green border-green/25",
  bad: "bg-red/15 text-red border-red/25",
  neutral: "bg-surface-3 text-muted border-border",
};

export function KpiNumber({
  value,
  unit,
  delta,
  deltaLabel,
  deltaDirection = "neutral",
  precision = 0,
  unitPosition = "suffix",
  className,
}: KpiNumberProps) {
  const reduce = useReducedMotion();
  const mv = useMotionValue(reduce ? value : 0);
  const display = useTransform(mv, (v) =>
    v.toLocaleString(undefined, {
      minimumFractionDigits: precision,
      maximumFractionDigits: precision,
    }),
  );

  useEffect(() => {
    if (reduce) {
      mv.set(value);
      return;
    }
    const controls = animate(mv, value, {
      duration: 0.6,
      ease: "easeOut",
    });
    return () => controls.stop();
  }, [value, reduce, mv]);

  const hasDelta = typeof delta === "number";
  const tone = hasDelta ? deltaTone(delta, deltaDirection) : "neutral";
  const DeltaIcon =
    !hasDelta || delta === 0 ? Minus : delta > 0 ? ArrowUp : ArrowDown;

  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <div className="flex items-baseline gap-1 font-mono tabular-nums">
        {unit && unitPosition === "prefix" && (
          <span className="text-2xl font-semibold text-muted">{unit}</span>
        )}
        <motion.span className="text-4xl font-bold leading-none text-fg">
          {display}
        </motion.span>
        {unit && unitPosition === "suffix" && (
          <span className="text-base font-medium text-muted">{unit}</span>
        )}
      </div>
      {hasDelta && (
        <div className="flex items-center gap-1.5">
          <Badge
            variant="outline"
            className={cn(
              "gap-0.5 font-mono text-[11px]",
              TONE_CLASSES[tone],
            )}
          >
            <DeltaIcon className="h-3 w-3" />
            {Math.abs(delta).toLocaleString(undefined, {
              minimumFractionDigits: precision,
              maximumFractionDigits: precision,
            })}
          </Badge>
          {deltaLabel && (
            <span className="text-[11px] text-muted">{deltaLabel}</span>
          )}
        </div>
      )}
    </div>
  );
}
