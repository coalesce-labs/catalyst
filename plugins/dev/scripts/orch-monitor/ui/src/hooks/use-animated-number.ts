import { useEffect, useRef, useState } from "react";

/**
 * Animates a numeric value from its previous state to a new target,
 * using ease-out cubic easing and requestAnimationFrame.
 *
 * On first render the value snaps immediately (no animation from 0).
 * Non-finite / NaN targets are treated as 0.
 */
export function useAnimatedNumber(target: number, duration = 400): number {
  const safeTarget = Number.isFinite(target) ? target : 0;

  const [displayed, setDisplayed] = useState(safeTarget);
  const rafId = useRef<number | null>(null);
  const prevTarget = useRef(safeTarget);
  const isFirstRender = useRef(true);

  useEffect(() => {
    // On first render, snap immediately — no animation from 0.
    if (isFirstRender.current) {
      isFirstRender.current = false;
      prevTarget.current = safeTarget;
      setDisplayed(safeTarget);
      return;
    }

    // If duration is 0, snap immediately.
    if (duration === 0) {
      prevTarget.current = safeTarget;
      setDisplayed(safeTarget);
      return;
    }

    const from = prevTarget.current;
    const to = safeTarget;
    prevTarget.current = to;

    // Nothing to animate.
    if (from === to) return;

    // Cancel any in-progress animation.
    if (rafId.current !== null) {
      cancelAnimationFrame(rafId.current);
    }

    const startTime = performance.now();

    const step = (now: number) => {
      const elapsed = now - startTime;
      const t = Math.min(elapsed / duration, 1);

      // Ease-out cubic: 1 - (1 - t)^3
      const eased = 1 - Math.pow(1 - t, 3);
      setDisplayed(from + (to - from) * eased);

      if (t < 1) {
        rafId.current = requestAnimationFrame(step);
      } else {
        rafId.current = null;
      }
    };

    rafId.current = requestAnimationFrame(step);

    // Cleanup: cancel the frame if the effect re-runs or the component unmounts.
    return () => {
      if (rafId.current !== null) {
        cancelAnimationFrame(rafId.current);
        rafId.current = null;
      }
    };
  }, [safeTarget, duration]);

  return displayed;
}
